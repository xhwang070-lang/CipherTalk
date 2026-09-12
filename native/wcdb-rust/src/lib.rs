use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::sync::Mutex;
use lazy_static::lazy_static;
use rusqlite::Connection;
use serde_json::json;

mod decrypt;
mod keys;

// ============= 全局状态 =============
lazy_static! {
    static ref ACCOUNTS: Mutex<HashMap<i64, AccountHandle>> = Mutex::new(HashMap::new());
    static ref NEXT_HANDLE: Mutex<i64> = Mutex::new(1);
    static ref LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
}

struct AccountHandle {
    session_db_path: String,
    db_storage_path: String,
    hex_key: String,
    wxid: String,
}

// ============= 辅助函数 =============
fn log_info(msg: &str) {
    if let Ok(mut logs) = LOGS.lock() {
        logs.push(format!("[INFO] {}", msg));
        if logs.len() > 1000 {
            logs.drain(0..500);
        }
    }
}

fn log_error(msg: &str) {
    if let Ok(mut logs) = LOGS.lock() {
        logs.push(format!("[ERROR] {}", msg));
        if logs.len() > 1000 {
            logs.drain(0..500);
        }
    }
}

unsafe fn c_str_to_string(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok().map(|s| s.to_string())
}

fn string_to_c_ptr(s: String) -> *mut c_void {
    CString::new(s).unwrap().into_raw() as *mut c_void
}

// ============= C FFI 导出函数 =============
#[no_mangle]
pub extern "C" fn wcdb_init() -> c_int {
    keys::load_keys();
    log_info("wcdb_init called");
    0
}

#[no_mangle]
pub extern "C" fn wcdb_shutdown() -> c_int {
    log_info("wcdb_shutdown called");
    if let Ok(mut accounts) = ACCOUNTS.lock() {
        accounts.clear();
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn wcdb_open_account(
    path: *const c_char,
    key: *const c_char,
    out_handle: *mut i64,
) -> c_int {
    let session_db_path = match c_str_to_string(path) {
        Some(s) => s,
        None => {
            log_error("wcdb_open_account: invalid path");
            return -1;
        }
    };

    let hex_key = match c_str_to_string(key) {
        Some(s) => s,
        None => {
            log_error("wcdb_open_account: invalid key");
            return -1;
        }
    };

    log_info(&format!("Opening account: path={}, key={}...", session_db_path, &hex_key[..std::cmp::min(16, hex_key.len())]));

    // 从 session.db 路径提取 db_storage 目录
    use std::path::Path;
    let session_path = Path::new(&session_db_path);
    let db_storage_path = if let Some(parent) = session_path.parent() {
        if let Some(grandparent) = parent.parent() {
            grandparent.to_string_lossy().to_string()
        } else {
            log_error("Cannot extract db_storage path: no grandparent");
            return -1;
        }
    } else {
        log_error("Cannot extract db_storage path: no parent");
        return -1;
    };

    log_info(&format!("Extracted db_storage_path: {}", db_storage_path));

    // 测试是否能用 SQLCipher 打开数据库
    // 去掉可能的 0x 前缀
    let clean_key = hex_key.strip_prefix("0x").unwrap_or(&hex_key);

    match test_sqlcipher_connection(&session_db_path, clean_key) {
        Ok(_) => {
            log_info("SQLCipher connection test successful");
        }
        Err(e) => {
            log_error(&format!("SQLCipher connection test failed: {}", e));
            return -1;
        }
    }

    // 创建账号句柄
    let handle_id = {
        let mut next = NEXT_HANDLE.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    };

    let account = AccountHandle {
        session_db_path: session_db_path.clone(),
        db_storage_path,
        hex_key: clean_key.to_string(),
        wxid: String::new(),
    };

    if let Ok(mut accounts) = ACCOUNTS.lock() {
        accounts.insert(handle_id, account);
    }

    *out_handle = handle_id;
    log_info(&format!("Account opened with handle: {}", handle_id));
    0
}

#[no_mangle]
pub extern "C" fn wcdb_close_account(handle: i64) -> c_int {
    log_info(&format!("Closing account handle: {}", handle));
    if let Ok(mut accounts) = ACCOUNTS.lock() {
        accounts.remove(&handle);
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn wcdb_free_string(ptr: *mut c_void) {
    if !ptr.is_null() {
        let _ = CString::from_raw(ptr as *mut c_char);
    }
}

#[no_mangle]
pub unsafe extern "C" fn wcdb_get_logs(out_json: *mut *mut c_void) -> c_int {
    if out_json.is_null() {
        return -1;
    }

    let logs = if let Ok(logs) = LOGS.lock() {
        logs.clone()
    } else {
        vec![]
    };

    let logs_json = json!({ "logs": logs }).to_string();
    *out_json = string_to_c_ptr(logs_json);
    0
}

#[no_mangle]
pub unsafe extern "C" fn wcdb_exec_query(
    handle: i64,
    kind: *const c_char,
    path: *const c_char,
    sql: *const c_char,
    out_json: *mut *mut c_void,
) -> c_int {
    if out_json.is_null() {
        return -1;
    }

    let db_kind = c_str_to_string(kind).unwrap_or_default();
    let db_path = c_str_to_string(path).unwrap_or_default();
    let query = match c_str_to_string(sql) {
        Some(s) => s,
        None => {
            log_error("wcdb_exec_query: invalid SQL");
            return -1;
        }
    };

    log_info(&format!("Executing query: handle={}, kind={}, path={}, sql={}",
        handle, db_kind, db_path, &query[..query.len().min(100)]));

    // 获取账号信息并执行查询
    let accounts = ACCOUNTS.lock().unwrap();
    let account = match accounts.get(&handle) {
        Some(acc) => acc,
        None => {
            log_error(&format!("Invalid handle: {}", handle));
            *out_json = string_to_c_ptr(json!({"error": "Invalid handle"}).to_string());
            return -1;
        }
    };

    // 执行 SQLCipher 查询
    match exec_sqlcipher_query(account, &db_kind, &db_path, &query) {
        Ok(result_json) => {
            *out_json = string_to_c_ptr(result_json);
            0
        }
        Err(e) => {
            log_error(&format!("Query failed: {}", e));
            *out_json = string_to_c_ptr(json!({"error": e.to_string()}).to_string());
            -1
        }
    }
}

// ============= SQLCipher 操作函数 =============
fn test_sqlcipher_connection(db_path: &str, hex_key: &str) -> Result<(), Box<dyn std::error::Error>> {
    log_info(&format!("Testing key against {}", db_path));
    let conn = open_db_connection(db_path, hex_key)?;
    let ok: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))?;
    log_info(&format!("Key validation passed, sqlite_master tables={}", ok));
    Ok(())
}

fn hex_key_for_account(account: &AccountHandle) -> &str {
    &account.hex_key
}

fn cache_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("huaji-wcdb-cache")
}

fn stable_cache_id(db_path: &str, salt: &str, enc_key: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(db_path.as_bytes());
    hasher.update(b"|");
    hasher.update(salt.as_bytes());
    hasher.update(b"|");
    hasher.update(enc_key.as_bytes());
    hex::encode(&hasher.finalize()[..16])
}

fn file_sig(path: &str) -> String {
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(mtime) = meta.modified() {
            if let Ok(d) = mtime.duration_since(std::time::UNIX_EPOCH) {
                return format!("{}:{}", d.as_millis(), meta.len());
            }
        }
    }
    "x".to_string()
}

fn cache_sig(db_path: &str) -> String {
    // Keep one file per database. WAL mtime only goes into the sidecar so
    // WeChat writes refresh the same cache instead of creating a new copy.
    format!("{}|{}", file_sig(db_path), file_sig(&format!("{}-wal", db_path)))
}

const CACHE_CAP_BYTES: u64 = 8 * 1024 * 1024 * 1024;

fn prune_cache(dir: &std::path::Path) {
    let mut files: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("db") {
                return None;
            }
            let meta = e.metadata().ok()?;
            Some((path, meta.len(), meta.modified().ok()?))
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, len, _)| *len).sum();
    if total <= CACHE_CAP_BYTES {
        return;
    }
    files.sort_by_key(|(_, _, mtime)| *mtime);
    for (path, len, _) in files {
        if total <= CACHE_CAP_BYTES {
            break;
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sig"));
        total = total.saturating_sub(len);
        log_info(&format!("Pruned stale wcdb cache {}", path.display()));
    }
}

fn materialize_plaintext(db_path: &str, hex_key: &str) -> Result<String, Box<dyn std::error::Error>> {
    if keys::is_plaintext_sqlite(db_path) {
        return Ok(db_path.to_string());
    }
    let (enc_key, salt) = if let Some(pair) = keys::enc_key_for_file(db_path) {
        pair
    } else {
        let k = hex_key.strip_prefix("0x").unwrap_or(hex_key).to_lowercase();
        if k.len() != 64 {
            return Err("no local enc_key for encrypted database".into());
        }
        let salt = keys::file_salt_hex(db_path).unwrap_or_default();
        (k, salt)
    };
    let dir = cache_dir();
    std::fs::create_dir_all(&dir)?;
    let id = stable_cache_id(db_path, &salt, &enc_key);
    let cache = dir.join(format!("{}.db", id));
    let cache_wal = std::path::PathBuf::from(format!("{}-wal", cache.to_string_lossy()));
    let cache_shm = std::path::PathBuf::from(format!("{}-shm", cache.to_string_lossy()));
    let sig_path = dir.join(format!("{}.sig", id));
    let sig = cache_sig(db_path);
    if cache.is_file() {
        if let Ok(old) = std::fs::read_to_string(&sig_path) {
            if old.trim() == sig {
                return Ok(cache.to_string_lossy().to_string());
            }
        }
    }
    let decryptor = decrypt::WeChatDecryptor::new(&enc_key)?;
    let enc_len = std::fs::metadata(db_path)?.len();
    let cache_len = cache.metadata().map(|m| m.len()).unwrap_or(0);
    if !cache.is_file() || cache_len == 0 || cache_len > enc_len {
        log_info(&format!("Decrypting live db into cache: {}", db_path));
        let bytes = decryptor.decrypt_database_file(db_path)?;
        let tmp = dir.join(format!("{}.tmp", id));
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, &cache)?;
    } else if enc_len > cache_len {
        log_info(&format!("Appending new db pages: {} -> {}", cache_len, enc_len));
        match decryptor.decrypt_database_tail(db_path, cache_len) {
            Ok(tail) if !tail.is_empty() => {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new().append(true).open(&cache)?;
                f.write_all(&tail)?;
            }
            Ok(_) => {}
            Err(e) => {
                log_error(&format!("tail decrypt failed, full decrypt: {}", e));
                let bytes = decryptor.decrypt_database_file(db_path)?;
                std::fs::write(&cache, &bytes)?;
            }
        }
    }
    let wal_src = format!("{}-wal", db_path);
    if std::path::Path::new(&wal_src).is_file() {
        match decryptor.decrypt_wal_file(&wal_src) {
            Ok(wal_bytes) => {
                std::fs::write(&cache_wal, wal_bytes)?;
                log_info(&format!("Decrypted WAL into {}", cache_wal.display()));
            }
            Err(e) => {
                log_error(&format!("WAL decrypt failed, using checkpoint snapshot: {}", e));
                let _ = std::fs::remove_file(&cache_wal);
            }
        }
    } else {
        let _ = std::fs::remove_file(&cache_wal);
    }
    let _ = std::fs::remove_file(&cache_shm);
    let wal_ready = !std::path::Path::new(&wal_src).is_file() || cache_wal.is_file();
    if wal_ready {
        let _ = std::fs::write(&sig_path, sig.as_bytes());
    }
    prune_cache(&dir);
    Ok(cache.to_string_lossy().to_string())
}

fn open_db_connection(db_path: &str, hex_key: &str) -> Result<Connection, Box<dyn std::error::Error>> {
    let plain = materialize_plaintext(db_path, hex_key)?;
    match Connection::open(&plain) {
        Ok(conn) => {
            log_info(&format!("Opened local-decrypted sqlite: {}", plain));
            Ok(conn)
        }
        Err(e) => {
            log_error(&format!("sqlite open with WAL failed, retry without WAL: {}", e));
            let _ = std::fs::remove_file(format!("{}-wal", plain));
            let _ = std::fs::remove_file(format!("{}-shm", plain));
            match Connection::open(&plain) {
                Ok(conn) => Ok(conn),
                Err(e2) => {
                    let _ = std::fs::remove_file(&plain);
                    let path = std::path::Path::new(&plain);
                    let _ = std::fs::remove_file(path.with_extension("sig"));
                    log_error(&format!("sqlite open failed, dropped cache {}: {}", plain, e2));
                    Err(e2.into())
                }
            }
        }
    }
}

fn exec_sqlcipher_query(
    account: &AccountHandle,
    kind: &str,
    relative_path: &str,
    sql: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    use std::path::PathBuf;

    log_info("=== Query Start ===");
    log_info(&format!("kind: {}", kind));
    log_info(&format!("relative_path: {}", relative_path));
    log_info(&format!("sql: {}", sql));

    // 确定要查询的数据库文件路径
    let db_file_path: PathBuf = if kind.is_empty() && relative_path.is_empty() {
        PathBuf::from(&account.session_db_path)
    } else {
        let mut path = PathBuf::from(&account.db_storage_path);
        path.push(kind);
        if relative_path.is_empty() {
            path.push(format!("{}.db", kind));
        } else {
            path.push(relative_path);
        }
        path
    };

    log_info(&format!("Database path: {:?}", db_file_path));

    if !db_file_path.is_file() {
        let error_msg = format!("Database file not found: {:?}", db_file_path);
        log_info(&error_msg);
        return Err(error_msg.into());
    }

    let conn = open_db_connection(db_file_path.to_str().unwrap_or(""), hex_key_for_account(account))?;

    log_info("Database opened with SQLCipher, executing query...");

    // 执行查询
    let mut stmt = conn.prepare(sql)?;
    let column_count = stmt.column_count();

    log_info(&format!("Query prepared, {} columns", column_count));

    // 收集列名
    let column_names: Vec<String> = (0..column_count)
        .map(|i| stmt.column_name(i).unwrap_or("").to_string())
        .collect();

    let mut rows = Vec::new();
    let mut query_rows = stmt.query([])?;
    while let Some(row) = query_rows.next()? {
        let mut row_map = serde_json::Map::new();
        for i in 0..column_count {
            let col_name = &column_names[i];
            let value: serde_json::Value = match row.get_ref(i)? {
                rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                rusqlite::types::ValueRef::Integer(v) => json!(v),
                rusqlite::types::ValueRef::Real(v) => json!(v),
                rusqlite::types::ValueRef::Text(v) => {
                    json!(String::from_utf8_lossy(v).to_string())
                }
                rusqlite::types::ValueRef::Blob(v) => {
                    json!(hex::encode(v))
                }
            };
            row_map.insert(col_name.clone(), value);
        }
        rows.push(serde_json::Value::Object(row_map));
    }

    log_info(&format!("Query complete, {} rows returned", rows.len()));

    let result = json!(rows).to_string();
    log_info(&format!("JSON result length: {} bytes", result.len()));
    log_info("=== Query End ===");

    Ok(result)
}


#[no_mangle]
pub unsafe extern "C" fn wcdb_get_sns_timeline(
    _handle: i64,
    _limit: c_int,
    _offset: c_int,
    _username: *const c_char,
    _keyword: *const c_char,
    _start_time: c_int,
    _end_time: c_int,
    _out_json: *mut *mut c_void,
) -> c_int {
    // Force JS SQL fallback used by Huaji/CipherTalk snsService.
    -1
}

#[no_mangle]
pub extern "C" fn wcdb_check_license() -> c_int {
    0
}

#[no_mangle]
pub unsafe extern "C" fn wcdb_set_app_version(_version: *const c_char) -> c_int {
    0
}

#[no_mangle]
pub unsafe extern "C" fn wcdb_set_client_info(
    _app: *const c_char,
    _channel: *const c_char,
    _version: *const c_char,
) -> c_int {
    0
}

#[no_mangle]
pub unsafe extern "C" fn wcdb_set_my_wxid(_wxid: *const c_char) -> c_int {
    0
}

#[no_mangle]
pub unsafe extern "C" fn wcdb_get_device_id(out_id: *mut *mut c_void) -> c_int {
    if out_id.is_null() {
        return -1;
    }
    *out_id = string_to_c_ptr("huaji-local".to_string());
    0
}
