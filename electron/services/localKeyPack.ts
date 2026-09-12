import { app } from 'electron'
import { copyFileSync, existsSync, openSync, readFileSync, readSync, closeSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { getUserDataPath } from './runtimePaths'

export interface LocalDbKey {
  name: string
  enc_key: string
  salt: string
}

export function userDataKeysPath(): string {
  return join(getUserDataPath(), 'all_keys.json')
}

export function applyKeyPackEnv(filePath: string): void {
  process.env.HUAJI_ALL_KEYS_JSON = filePath
  process.env.WEFLOW_ALL_KEYS_JSON = filePath
}

export function candidateKeyPackPaths(configured?: string): string[] {
  const out: string[] = []
  const add = (value?: string) => {
    const next = String(value || '').trim()
    if (next && !out.includes(next)) out.push(next)
  }
  add(process.env.HUAJI_ALL_KEYS_JSON)
  add(process.env.WEFLOW_ALL_KEYS_JSON)
  add(configured)
  add(userDataKeysPath())
  try {
    add(join(app.getPath('userData'), 'all_keys.json'))
  } catch {
    /* ignore */
  }
  try {
    add(join(app.getPath('desktop'), 'Huaji', 'tools', 'wechat-key-extractor', 'all_keys.json'))
  } catch {
    /* ignore */
  }
  add(join(getUserDataPath(), '..', 'Huaji', 'all_keys.json'))
  add('C:\\Users\\Administrator\\Desktop\\Huaji\\tools\\wechat-key-extractor\\all_keys.json')
  return out
}

export function resolveKeyPackPath(configured?: string): string | null {
  for (const filePath of candidateKeyPackPaths(configured)) {
    if (existsSync(filePath)) return filePath
  }
  return null
}

export function parseKeyPack(filePath: string): LocalDbKey[] {
  const data = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, any>
  const keys: LocalDbKey[] = []
  for (const [name, item] of Object.entries(data || {})) {
    if (name.startsWith('_') || !item || typeof item !== 'object') continue
    const enc_key = String(item.enc_key || '').trim().toLowerCase()
    const salt = String(item.salt || '').trim().toLowerCase()
    if (enc_key.length === 64) keys.push({ name, enc_key, salt })
  }
  return keys
}

function readSaltHex(filePath: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(16)
    if (readSync(fd, buf, 0, 16, 0) !== 16) return null
    if (buf.subarray(0, 15).toString('utf8') === 'SQLite format 3') return null
    return buf.toString('hex')
  } catch {
    return null
  } finally {
    if (fd != null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function collectDbFiles(dir: string, out: string[], depth = 0): void {
  if (depth > 5 || out.length >= 80) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectDbFiles(full, out, depth + 1)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.db')) out.push(full)
  }
}

export function pickEncKey(keys: LocalDbKey[], dbPath?: string, wxid?: string): string | null {
  if (keys.length === 0) return null
  const root = dbPath && wxid ? join(dbPath, wxid) : dbPath
  if (root && existsSync(root)) {
    const files: string[] = []
    collectDbFiles(root, files)
    const bySalt = new Map(keys.filter(k => k.salt.length === 32).map(k => [k.salt, k.enc_key]))
    for (const file of files) {
      const salt = readSaltHex(file)
      if (salt && bySalt.has(salt)) return bySalt.get(salt) || null
    }
  }
  return keys[0].enc_key
}

export function importKeyPack(sourcePath: string): string {
  const target = userDataKeysPath()
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(sourcePath, target)
  applyKeyPackEnv(target)
  return target
}


export function upsertEncKey(encKey: string, dbRoot?: string, wxid?: string): string {
  const key = String(encKey || '').replace(/^0x/i, '').trim().toLowerCase()
  const target = userDataKeysPath()
  let data: Record<string, any> = {}
  const existing = resolveKeyPackPath()
  if (existing && existsSync(existing)) {
    try { data = JSON.parse(readFileSync(existing, 'utf8')) } catch { data = {} }
  }
  const files: string[] = []
  const root = dbRoot && wxid ? join(dbRoot, wxid) : dbRoot
  if (root && existsSync(root)) collectDbFiles(root, files)
  let wrote = 0
  for (const file of files) {
    const salt = readSaltHex(file)
    if (!salt || salt.length !== 32) continue
    data[basename(file)] = { salt, enc_key: key }
    wrote += 1
  }
  if (wrote === 0 && key.length === 64) {
    data.scanned = { salt: '', enc_key: key }
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(data, null, 2), 'utf8')
  applyKeyPackEnv(target)
  return target
}
