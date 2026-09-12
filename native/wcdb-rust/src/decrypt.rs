use aes::Aes256;
use cbc::{
    cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit},
    Decryptor,
};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha512;
use std::fs;
use std::path::Path;

type Aes256CbcDec = Decryptor<Aes256>;
type HmacSha512 = Hmac<Sha512>;

const PAGE_SIZE: usize = 4096;
const SALT_SIZE: usize = 16;
const IV_SIZE: usize = 16;
const HMAC_SIZE: usize = 64;
const RESERVE_SIZE: usize = 80; // IV(16) + HMAC-SHA512(64)
const SQLITE_HDR: &[u8] = b"SQLite format 3\0";

pub struct WeChatDecryptor {
    key_bytes: Vec<u8>,
}

impl WeChatDecryptor {
    pub fn new(hex_key: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let hex_str = hex_key.strip_prefix("0x").unwrap_or(hex_key);
        let key_bytes = hex::decode(hex_str)?;
        if key_bytes.len() != 32 {
            return Err(format!(
                "密钥长度必须是 32 字节 (64 个十六进制字符)，实际长度: {}",
                key_bytes.len()
            )
            .into());
        }
        Ok(Self { key_bytes })
    }

    pub fn decrypt_database_file<P: AsRef<Path>>(
        &self,
        path: P,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let encrypted_data = fs::read(path)?;
        self.decrypt_database(&encrypted_data)
    }

    pub fn decrypt_database(
        &self,
        encrypted_data: &[u8],
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        if encrypted_data.len() < PAGE_SIZE {
            return Err("文件太小，不是有效的数据库".into());
        }
        if encrypted_data.starts_with(SQLITE_HDR) {
            return Ok(encrypted_data.to_vec());
        }

        let page1 = &encrypted_data[..PAGE_SIZE];
        let enc_key = resolve_enc_key(&self.key_bytes, page1)?;
        let total_pages = encrypted_data.len() / PAGE_SIZE;
        let mut decrypted_data = Vec::with_capacity(total_pages * PAGE_SIZE);
        for i in 0..total_pages {
            let start = i * PAGE_SIZE;
            let page = &encrypted_data[start..start + PAGE_SIZE];
            decrypted_data.extend_from_slice(&decrypt_page(&enc_key, page, (i + 1) as u32)?);
        }
        if !is_valid_sqlite_header(&decrypted_data) {
            return Err("解密后的数据库头无效".into());
        }
        Ok(decrypted_data)
    }

    pub fn decrypt_database_tail<P: AsRef<Path>>(
        &self,
        path: P,
        already_bytes: u64,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let encrypted_data = fs::read(path)?;
        if encrypted_data.len() as u64 <= already_bytes {
            return Ok(Vec::new());
        }
        if already_bytes % PAGE_SIZE as u64 != 0 {
            return Err("缓存长度未按页对齐".into());
        }
        let page1 = encrypted_data.get(..PAGE_SIZE).ok_or("文件太小")?;
        let enc_key = resolve_enc_key(&self.key_bytes, page1)?;
        let start_page = (already_bytes / PAGE_SIZE as u64) as u32; // 0-based
        let mut out = Vec::new();
        let total_pages = encrypted_data.len() / PAGE_SIZE;
        for i in start_page as usize..total_pages {
            let start = i * PAGE_SIZE;
            let page = &encrypted_data[start..start + PAGE_SIZE];
            out.extend_from_slice(&decrypt_page(&enc_key, page, (i + 1) as u32)?);
        }
        Ok(out)
    }

    pub fn decrypt_wal_file<Q: AsRef<Path>>(
        &self,
        wal_path: Q,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        if self.key_bytes.len() != 32 {
            return Err("密钥长度必须是 32 字节".into());
        }
        let mut enc_key = [0u8; 32];
        enc_key.copy_from_slice(&self.key_bytes);
        let wal = read_shared(wal_path.as_ref())?;
        decrypt_wal_bytes(&enc_key, &wal)
    }

    /// 把加密 WAL 里已提交的页直接打进明文缓存库，不走 sqlite 的 WAL 校验。
    pub fn apply_wal_to_plain_db<P, Q, R>(
        &self,
        encrypted_db: P,
        wal_path: Q,
        plain_db: R,
    ) -> Result<u32, Box<dyn std::error::Error>>
    where
        P: AsRef<Path>,
        Q: AsRef<Path>,
        R: AsRef<Path>,
    {
        let mut page1 = [0u8; PAGE_SIZE];
        {
            use std::io::Read;
            let mut f = fs::File::open(encrypted_db.as_ref())?;
            f.read_exact(&mut page1)?;
        }
        let enc_key = resolve_enc_key(&self.key_bytes, &page1)?;
        let wal = read_shared(wal_path.as_ref())?;
        apply_wal_pages(&enc_key, &page1[..SALT_SIZE], &wal, plain_db.as_ref())
    }
}

fn resolve_enc_key(
    candidate: &[u8],
    page1: &[u8],
) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    if candidate.len() != 32 {
        return Err("密钥长度必须是 32 字节".into());
    }
    let mut raw = [0u8; 32];
    raw.copy_from_slice(candidate);
    if hmac_ok(&raw, page1) {
        return Ok(raw);
    }
    let derived = derive_sqlcipher_key(&raw, &page1[..SALT_SIZE]);
    if hmac_ok(&derived, page1) {
        return Ok(derived);
    }
    Err("HMAC 校验失败，密钥与数据库不匹配".into())
}

fn derive_sqlcipher_key(passphrase: &[u8], salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha512>(passphrase, salt, 256_000, &mut key);
    key
}

fn hmac_ok(enc_key: &[u8], page1: &[u8]) -> bool {
    if page1.len() < PAGE_SIZE {
        return false;
    }
    let salt = &page1[..SALT_SIZE];
    let mac_salt: Vec<u8> = salt.iter().map(|b| b ^ 0x3A).collect();
    let mut mac_key = [0u8; 32];
    pbkdf2_hmac::<Sha512>(enc_key, &mac_salt, 2, &mut mac_key);
    let hmac_data = &page1[SALT_SIZE..PAGE_SIZE - HMAC_SIZE];
    let stored = &page1[PAGE_SIZE - HMAC_SIZE..];
    let Ok(mut mac) = HmacSha512::new_from_slice(&mac_key) else {
        return false;
    };
    mac.update(hmac_data);
    mac.update(&1u32.to_le_bytes());
    mac.verify_slice(stored).is_ok()
}

fn page_hmac_ok(enc_key: &[u8], salt: &[u8], page: &[u8], pgno: u32) -> bool {
    if page.len() < PAGE_SIZE || salt.len() < SALT_SIZE {
        return false;
    }
    let mac_salt: Vec<u8> = salt.iter().map(|b| b ^ 0x3A).collect();
    let mut mac_key = [0u8; 32];
    pbkdf2_hmac::<Sha512>(enc_key, &mac_salt, 2, &mut mac_key);
    let start = if pgno == 1 { SALT_SIZE } else { 0 };
    let hmac_data = &page[start..PAGE_SIZE - HMAC_SIZE];
    let stored = &page[PAGE_SIZE - HMAC_SIZE..];
    let Ok(mut mac) = HmacSha512::new_from_slice(&mac_key) else {
        return false;
    };
    mac.update(hmac_data);
    mac.update(&pgno.to_le_bytes());
    mac.verify_slice(stored).is_ok()
}

fn aes_cbc_decrypt(
    key: &[u8; 32],
    iv: &[u8],
    data: &[u8],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if iv.len() != IV_SIZE || data.len() % 16 != 0 {
        return Err("AES 参数无效".into());
    }
    let cipher = Aes256CbcDec::new(key.into(), iv.into());
    let mut buf = data.to_vec();
    cipher
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("AES 解密失败: {:?}", e))?;
    Ok(buf)
}

fn decrypt_page(
    enc_key: &[u8; 32],
    page_data: &[u8],
    pgno: u32,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut page = page_data.to_vec();
    if page.len() < PAGE_SIZE {
        page.resize(PAGE_SIZE, 0);
    }
    let iv = page[PAGE_SIZE - RESERVE_SIZE..PAGE_SIZE - RESERVE_SIZE + IV_SIZE].to_vec();
    if pgno == 1 {
        let encrypted = page[SALT_SIZE..PAGE_SIZE - RESERVE_SIZE].to_vec();
        let decrypted = aes_cbc_decrypt(enc_key, &iv, &encrypted)?;
        let mut out = Vec::with_capacity(PAGE_SIZE);
        out.extend_from_slice(SQLITE_HDR);
        out.extend_from_slice(&decrypted);
        out.resize(PAGE_SIZE, 0);
        Ok(out)
    } else {
        let encrypted = page[..PAGE_SIZE - RESERVE_SIZE].to_vec();
        let mut out = aes_cbc_decrypt(enc_key, &iv, &encrypted)?;
        out.resize(PAGE_SIZE, 0);
        Ok(out)
    }
}

fn is_valid_sqlite_header(data: &[u8]) -> bool {
    if data.len() < 20 || &data[..16] != SQLITE_HDR {
        return false;
    }
    let mut page_size = u16::from_be_bytes([data[16], data[17]]) as u32;
    if page_size == 1 {
        page_size = 65536;
    }
    matches!(
        page_size,
        512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768 | 65536
    ) && matches!(data[18], 1 | 2)
        && matches!(data[19], 1 | 2)
}

fn read_shared(path: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    use std::io::Read;
    let mut last = None;
    for _ in 0..5 {
        match fs::File::open(path) {
            Ok(mut f) => {
                let mut buf = Vec::new();
                match f.read_to_end(&mut buf) {
                    Ok(_) if !buf.is_empty() => return Ok(buf),
                    Ok(_) => last = Some("empty wal".into()),
                    Err(e) => last = Some(e.to_string()),
                }
            }
            Err(e) => last = Some(e.to_string()),
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    Err(last.unwrap_or_else(|| "read wal failed".into()).into())
}

const WAL_HDR: usize = 32;
const WAL_FRAME_HDR: usize = 24;

fn wal_checksum(data: &[u8], mut s0: u32, mut s1: u32) -> (u32, u32) {
    let mut i = 0;
    while i + 8 <= data.len() {
        let x0 = u32::from_le_bytes(data[i..i + 4].try_into().unwrap());
        let x1 = u32::from_le_bytes(data[i + 4..i + 8].try_into().unwrap());
        s0 = s0.wrapping_add(x0).wrapping_add(s1);
        s1 = s1.wrapping_add(x1).wrapping_add(s0);
        i += 8;
    }
    (s0, s1)
}

fn apply_wal_pages(
    enc_key: &[u8; 32],
    db_salt: &[u8],
    wal: &[u8],
    plain_db: &Path,
) -> Result<u32, Box<dyn std::error::Error>> {
    use std::io::{Seek, SeekFrom, Write};
    if wal.len() < WAL_HDR {
        return Err("WAL 太小".into());
    }
    if wal[0..4] != [0x37, 0x7f, 0x06, 0x82] {
        return Err("WAL 头不是 SQLite WAL".into());
    }
    let page_size = u32::from_be_bytes(wal[8..12].try_into().unwrap()) as usize;
    if page_size != PAGE_SIZE {
        return Err(format!("不支持的 WAL page_size {}", page_size).into());
    }
    let header_salt = &wal[16..24];
    let frame_size = WAL_FRAME_HDR + page_size;
    let mut pending: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut commits = 0u32;
    let mut offset = WAL_HDR;
    let mut file = fs::OpenOptions::new().read(true).write(true).open(plain_db)?;
    let original_len = file.metadata()?.len();
    while offset + frame_size <= wal.len() {
        let frame = &wal[offset..offset + frame_size];
        let pgno = u32::from_be_bytes(frame[0..4].try_into().unwrap());
        if pgno == 0 {
            break;
        }
        if &frame[8..16] != header_salt {
            break;
        }
        let raw_page = &frame[WAL_FRAME_HDR..WAL_FRAME_HDR + page_size];
        if !page_hmac_ok(enc_key, db_salt, raw_page, pgno) {
            break;
        }
        let dbsize = u32::from_be_bytes(frame[4..8].try_into().unwrap());
        match decrypt_page(enc_key, raw_page, pgno) {
            Ok(page) => pending.push((pgno, page)),
            Err(_) => break,
        }
        if dbsize != 0 {
            for (pg, page) in pending.drain(..) {
                let pos = (pg as u64 - 1) * PAGE_SIZE as u64;
                file.seek(SeekFrom::Start(pos))?;
                file.write_all(&page)?;
            }
            let new_len = dbsize as u64 * PAGE_SIZE as u64;
            // WAL 环回后可能混进旧提交；禁止把缓存截得比原明文更短。
            if new_len >= original_len {
                file.set_len(new_len)?;
            }
            commits += 1;
        }
        offset += frame_size;
    }
    file.flush()?;
    Ok(commits)
}

fn decrypt_wal_bytes(
    enc_key: &[u8; 32],
    wal: &[u8],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if wal.len() < WAL_HDR {
        return Err("WAL 太小".into());
    }
    if wal[0..4] != [0x37, 0x7f, 0x06, 0x82] {
        return Err("WAL 头不是 SQLite WAL".into());
    }
    let page_size = u32::from_be_bytes(wal[8..12].try_into().unwrap()) as usize;
    if page_size != PAGE_SIZE {
        return Err(format!("不支持的 WAL page_size {}", page_size).into());
    }
    let frame_size = WAL_FRAME_HDR + page_size;
    let mut out = Vec::with_capacity(wal.len());
    out.extend_from_slice(&wal[..WAL_HDR]);
    let (mut s0, mut s1) = wal_checksum(&out[..24], 0, 0);
    // magic 0x377f0682: SQLite 用小端累加，校验和按大端写入
    out[24..28].copy_from_slice(&s0.to_be_bytes());
    out[28..32].copy_from_slice(&s1.to_be_bytes());

    let mut offset = WAL_HDR;
    while offset + frame_size <= wal.len() {
        let frame = &wal[offset..offset + frame_size];
        let pgno = u32::from_be_bytes(frame[0..4].try_into().unwrap());
        if pgno == 0 {
            break;
        }
        let decrypted = decrypt_page(enc_key, &frame[WAL_FRAME_HDR..], pgno)?;
        out.extend_from_slice(&frame[..8]);
        out.extend_from_slice(&frame[8..16]);
        (s0, s1) = wal_checksum(&frame[..8], s0, s1);
        (s0, s1) = wal_checksum(&decrypted, s0, s1);
        out.extend_from_slice(&s0.to_be_bytes());
        out.extend_from_slice(&s1.to_be_bytes());
        out.extend_from_slice(&decrypted);
        offset += frame_size;
    }
    Ok(out)
}
