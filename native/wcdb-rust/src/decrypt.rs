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
