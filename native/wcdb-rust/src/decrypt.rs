use aes::Aes256;
use cbc::{Decryptor, cipher::{BlockDecryptMut, KeyIvInit}};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha512;
use std::fs;
use std::path::Path;

type Aes256CbcDec = Decryptor<Aes256>;

const KDF_ITER: u32 = 256000;  // SQLCipher 4 uses 256,000 iterations
const PAGE_SIZE: usize = 4096;
const RESERVE_SIZE: usize = 80;  // SQLCipher 4: IV(16) + HMAC-SHA512(64) = 80 bytes

pub struct WeChatDecryptor {
    key_bytes: Vec<u8>,
}

impl WeChatDecryptor {
    pub fn new(hex_key: &str) -> Result<Self, Box<dyn std::error::Error>> {
        // 处理可能的 0x 前缀
        let hex_str = hex_key.strip_prefix("0x").unwrap_or(hex_key);
        let key_bytes = hex::decode(hex_str)?;
        // 密钥应该是 32 字节（64 个十六进制字符）
        if key_bytes.len() != 32 {
            return Err(format!("密钥长度必须是 32 字节 (64 个十六进制字符)，实际长度: {}", key_bytes.len()).into());
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
        let file_size = encrypted_data.len();

        if file_size < PAGE_SIZE {
            return Err("文件太小，不是有效的数据库".into());
        }

        // 检查是否已经是未加密数据库
        if &encrypted_data[..16] == b"SQLite format 3\0" {
            return Ok(encrypted_data.to_vec());
        }

        // 提取 salt (前 16 字节)
        let salt = &encrypted_data[..16];

        // 派生密钥 (PBKDF2-HMAC-SHA512, 256000 迭代)
        let mut derived_key = [0u8; 32];
        pbkdf2_hmac::<Sha512>(&self.key_bytes, salt, KDF_ITER, &mut derived_key);

        // 解密所有页面
        let total_pages = file_size / PAGE_SIZE;
        let mut decrypted_data = Vec::with_capacity(file_size);

        for page_num in 0..total_pages {
            let offset = page_num * PAGE_SIZE;
            let page_data = &encrypted_data[offset..offset + PAGE_SIZE];

            match self.decrypt_page(page_data, &derived_key, page_num) {
                Ok(decrypted_page) => {
                    decrypted_data.extend_from_slice(&decrypted_page);
                }
                Err(e) => {
                    return Err(format!("解密页面 {} 失败: {}", page_num, e).into());
                }
            }
        }

        // 验证 SQLite 头
        if &decrypted_data[..16] != b"SQLite format 3\0" {
            return Err("解密后的数据库头无效".into());
        }

        Ok(decrypted_data)
    }

    fn decrypt_page(
        &self,
        page_data: &[u8],
        derived_key: &[u8; 32],
        page_num: usize,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let (iv_start, encrypted_start, encrypted_end) = if page_num == 0 {
            // 第一页: salt(16) + IV(16) + 加密数据 + 保留空间(48)
            (16, 32, PAGE_SIZE - RESERVE_SIZE)
        } else {
            // 其他页: IV(16) + 加密数据 + 保留空间(48)
            (0, 16, PAGE_SIZE - RESERVE_SIZE)
        };

        let iv = &page_data[iv_start..iv_start + 16];
        let encrypted_content = &page_data[encrypted_start..encrypted_end];
        let reserve_data = &page_data[PAGE_SIZE - RESERVE_SIZE..];

        // AES-256-CBC 解密
        let cipher = Aes256CbcDec::new(derived_key.into(), iv.into());
        let mut decrypted_content = encrypted_content.to_vec();

        // 解密（处理填充）
        cipher.decrypt_padded_mut::<cbc::cipher::block_padding::NoPadding>(&mut decrypted_content)
            .map_err(|e| format!("AES 解密失败: {:?}", e))?;

        // 重建页面（保持 4096 字节页面大小）
        let mut result = Vec::with_capacity(PAGE_SIZE);

        if page_num == 0 {
            // 第一页：用 SQLite 魔数替换 salt 位置，然后接上解密的内容
            // decrypted_content 包含原始 offset 16+ 的所有数据
            result.extend_from_slice(b"SQLite format 3\0");
            result.extend_from_slice(&decrypted_content);  // 不跳过，全部保留
        } else {
            result.extend_from_slice(&decrypted_content);
        }

        // 用零填充到 4096 字节
        result.resize(PAGE_SIZE, 0);

        Ok(result)
    }
}
