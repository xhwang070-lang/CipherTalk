use hex;
use lazy_static::lazy_static;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::sync::Mutex;

lazy_static! {
    static ref KEYS_BY_SALT: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
    static ref LOADED: Mutex<bool> = Mutex::new(false);
}

fn default_keys_path() -> String {
    if let Ok(p) = std::env::var("WEFLOW_ALL_KEYS_JSON") {
        if !p.trim().is_empty() {
            return p;
        }
    }
    r"C:\Users\Administrator\Desktop\WeFlow\tools\wechat-key-extractor\all_keys.json".to_string()
}

pub fn load_keys() {
    if let Ok(flag) = LOADED.lock() {
        if *flag {
            return;
        }
    }
    let path = default_keys_path();
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return,
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return,
    };
    let mut map = HashMap::new();
    for (name, item) in obj {
        if name.starts_with('_') {
            continue;
        }
        let salt = item.get("salt").and_then(|v| v.as_str()).unwrap_or("");
        let enc = item.get("enc_key").and_then(|v| v.as_str()).unwrap_or("");
        if salt.len() == 32 && enc.len() == 64 {
            map.insert(salt.to_lowercase(), enc.to_lowercase());
        }
    }
    if let Ok(mut keys) = KEYS_BY_SALT.lock() {
        *keys = map;
    }
    if let Ok(mut flag) = LOADED.lock() {
        *flag = true;
    }
}

pub fn file_salt_hex(path: &str) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut salt = [0u8; 16];
    f.read_exact(&mut salt).ok()?;
    Some(hex::encode(salt))
}

pub fn enc_key_for_file(path: &str) -> Option<(String, String)> {
    load_keys();
    let salt = file_salt_hex(path)?;
    let keys = KEYS_BY_SALT.lock().ok()?;
    let enc = keys.get(&salt)?.clone();
    Some((enc, salt))
}

pub fn sqlcipher_raw_key_pragma(path: &str) -> Option<String> {
    let (enc, salt) = enc_key_for_file(path)?;
    Some(format!("x'{}{}'", enc, salt))
}

pub fn is_plaintext_sqlite(path: &str) -> bool {
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut hdr = [0u8; 16];
    if f.read_exact(&mut hdr).is_err() {
        return false;
    }
    &hdr == b"SQLite format 3\0"
}
