import { createHmac, pbkdf2Sync } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const PAGE_SZ = 4096
const KEY_SZ = 32
const SALT_SZ = 16
const NEEDLE = Buffer.from('com.Tencent.WCDB.Config.Cipher')
const XOR_MASK = Buffer.from(
  'd2c7442458020000004889442450488b450048844c2448488944254048584c24',
  'hex',
)
const MAX_USER = 0x0000800000000000n
const BLOB_MAX = 1024
const MEM_COMMIT = 0x1000
const PAGE_GUARD = 0x100
const READABLE = new Set([0x02, 0x04, 0x08, 0x20, 0x40, 0x80])
const LITERAL_RE = /[xX]'([0-9a-fA-F]{64,192})'/g

export type RuntimeScanProgress = (status: string) => void

export type RuntimeScanResult = {
  key: string | null
  stats: Record<string, number>
  error?: string
}

function xorRepeat(data: Buffer, mask: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i += 1) out[i] = data[i] ^ mask[i % mask.length]
  return out
}

function probableKey(data: Buffer): boolean {
  if (data.length !== KEY_SZ) return false
  const uniq = new Set(data)
  return uniq.size >= 15 && !data.equals(Buffer.alloc(KEY_SZ, 0)) && !data.equals(Buffer.alloc(KEY_SZ, 0xff))
}

function verifyEncKey(encKey: Buffer, page1: Buffer): boolean {
  if (page1.length < PAGE_SZ) return false
  const salt = page1.subarray(0, SALT_SZ)
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a))
  const macKey = pbkdf2Sync(encKey, macSalt, 2, KEY_SZ, 'sha512')
  const hmacData = page1.subarray(SALT_SZ, PAGE_SZ - 80 + 16)
  const stored = page1.subarray(PAGE_SZ - 64)
  const hm = createHmac('sha512', macKey)
  hm.update(hmacData)
  hm.update(Buffer.from([1, 0, 0, 0]))
  return hm.digest().equals(stored)
}

function keyCandidates(blob: Buffer): Array<{ encKeyHex: string; saltHex: string | null }> {
  if (!blob.length || blob.length > BLOB_MAX) return []
  const decoded = xorRepeat(blob, XOR_MASK).toString('latin1')
  const out: Array<{ encKeyHex: string; saltHex: string | null }> = []
  const seen = new Set<string>()
  LITERAL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LITERAL_RE.exec(decoded))) {
    const run = match[1].toLowerCase()
    const starts = [0]
    if (run.length > 96) {
      for (let i = 0; i <= run.length - 64; i += 32) starts.push(i)
      starts.push(run.length - 64)
    }
    for (const start of [...new Set(starts)]) {
      if (start < 0 || start + 64 > run.length) continue
      const encKeyHex = run.slice(start, start + 64)
      let encKey: Buffer
      try { encKey = Buffer.from(encKeyHex, 'hex') } catch { continue }
      if (!probableKey(encKey)) continue
      const saltHex = start + 96 <= run.length ? run.slice(start + 64, start + 96) : null
      const id = encKeyHex + ':' + (saltHex || '')
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ encKeyHex, saltHex })
    }
  }
  return out
}

function u64(buf: Buffer, offset: number): bigint {
  if (offset < 0 || offset + 8 > buf.length) return 0n
  return buf.readBigUInt64LE(offset)
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function listMainWeixinPids(): number[] {
  const { execSync } = require('child_process') as typeof import('child_process')
  let raw = ''
  try {
    raw = execSync('wmic process where "name=\'Weixin.exe\'" get ProcessId,CommandLine /FORMAT:LIST', {
      encoding: 'utf8',
      windowsHide: true,
    })
  } catch {
    return []
  }
  const blocks = raw.split(/\r?\n\r?\n/)
  const pids: number[] = []
  const helpers: number[] = []
  for (const block of blocks) {
    const cmd = (block.match(/CommandLine=(.*)/) || [])[1]?.trim() || ''
    const pid = Number((block.match(/ProcessId=(\d+)/) || [])[1] || 0)
    if (!pid) continue
    if (/--type=/i.test(cmd)) helpers.push(pid)
    else pids.push(pid)
  }
  return pids.length ? pids : helpers.slice(0, 2)
}

export async function scanWeixinRuntimeKey(options: {
  contactDbPaths: string[]
  onProgress?: RuntimeScanProgress
}): Promise<RuntimeScanResult> {
  const stats = {
    pids: 0,
    regions: 0,
    needles: 0,
    nodes: 0,
    candidates: 0,
    verified: 0,
  }
  if (process.platform !== 'win32') return { key: null, stats, error: 'not-windows' }
  const pages = (options.contactDbPaths || []).filter((item) => existsSync(item)).map((item) => readFileSync(item).subarray(0, PAGE_SZ)).filter((page) => page.length >= PAGE_SZ)
  if (!pages.length) return { key: null, stats, error: 'no-contact-db' }

  const koffi = require('koffi')
  const kernel32 = koffi.load('kernel32.dll')
  const OpenProcess = kernel32.func('uintptr __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)')
  const CloseHandle = kernel32.func('int __stdcall CloseHandle(uintptr hObject)')
  const ReadProcessMemory = kernel32.func('int __stdcall ReadProcessMemory(uintptr hProcess, uintptr lpBaseAddress, void *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)')
  const VirtualQueryEx = kernel32.func('size_t __stdcall VirtualQueryEx(uintptr hProcess, uintptr lpAddress, void *lpBuffer, size_t dwLength)')

  const readMem = (handle: unknown, addr: bigint, size: number): Buffer | null => {
    if (size <= 0 || size > 8 * 1024 * 1024) return null
    const buf = Buffer.alloc(size)
    const readBox = [0]
    const ok = ReadProcessMemory(handle, addr, buf, size, readBox)
    const n = Number(readBox[0] || 0)
    if (!ok || n <= 0) return null
    return n === size ? buf : buf.subarray(0, n)
  }

  const pids = listMainWeixinPids()
  stats.pids = pids.length
  options.onProgress?.('正在扫描微信 4.1 运行时密钥...')

  for (const pid of pids) {
    const handle = OpenProcess(0x0410, 0, pid)
    if (!handle) continue
    try {
      const regions: Array<{ base: bigint; size: number }> = []
      let addr = 0n
      const mbi = Buffer.alloc(48)
      while (addr < 0x7fffffffffffn) {
        const got = Number(VirtualQueryEx(handle, addr, mbi, 48) || 0)
        if (!got) break
        const base = mbi.readBigUInt64LE(0)
        const regionSize = Number(mbi.readBigUInt64LE(24))
        const state = mbi.readUInt32LE(32)
        const protect = mbi.readUInt32LE(36)
        if (state === MEM_COMMIT && !(protect & PAGE_GUARD) && READABLE.has(protect & 0xff) && regionSize > 0 && regionSize < 200 * 1024 * 1024) {
          regions.push({ base, size: regionSize })
        }
        const next = base + BigInt(regionSize || 0x1000)
        if (next <= addr) break
        addr = next
      }
      stats.regions += regions.length

      const needleAddrs: bigint[] = []
      let scanned = 0
      for (const region of regions) {
        let offset = 0
        while (offset < region.size) {
          const chunk = Math.min(2 * 1024 * 1024, region.size - offset)
          const data = readMem(handle, region.base + BigInt(offset), chunk)
          if (data) {
            let pos = data.indexOf(NEEDLE)
            while (pos >= 0) {
              needleAddrs.push(region.base + BigInt(offset + pos))
              pos = data.indexOf(NEEDLE, pos + 1)
            }
          }
          offset += chunk
        }
        scanned += 1
        if (scanned % 12 === 0) await yieldEventLoop()
      }
      stats.needles += needleAddrs.length
      if (!needleAddrs.length) continue

      const patterns = needleAddrs.map((naddr) => {
        const buf = Buffer.alloc(16)
        buf.writeBigUInt64LE(naddr, 0)
        buf.writeBigUInt64LE(BigInt(NEEDLE.length), 8)
        return buf
      })

      const seen = new Set<string>()
      for (const region of regions) {
        let offset = 0
        while (offset < region.size) {
          const chunk = Math.min(2 * 1024 * 1024, region.size - offset)
          const data = readMem(handle, region.base + BigInt(offset), chunk)
          if (data) {
            for (const pattern of patterns) {
              let pos = data.indexOf(pattern)
              while (pos >= 0) {
                const qaddr = region.base + BigInt(offset + pos)
                const node = readMem(handle, qaddr - 0x10n, 0x50)
                if (node && node.length >= 0x40) {
                  const namePtr = u64(node, 0x10)
                  const nameLen = u64(node, 0x18)
                  const configPtr = u64(node, 0x28)
                  if (needleAddrs.includes(namePtr) && nameLen === BigInt(NEEDLE.length) && configPtr > 0x10000n && configPtr < MAX_USER) {
                    stats.nodes += 1
                    const obj = readMem(handle, configPtr + 0x88n, 0x28)
                    if (obj && obj.length >= 0x18) {
                      const dataPtr = u64(obj, 0x8)
                      const dataLen = Number(u64(obj, 0x10))
                      if (dataLen > 0 && dataLen <= BLOB_MAX && dataPtr > 0x10000n && dataPtr < MAX_USER) {
                        const blob = readMem(handle, dataPtr, dataLen)
                        if (blob && blob.length === dataLen) {
                          for (const cand of keyCandidates(blob)) {
                            if (seen.has(cand.encKeyHex)) continue
                            seen.add(cand.encKeyHex)
                            stats.candidates += 1
                            const encKey = Buffer.from(cand.encKeyHex, 'hex')
                            if (pages.some((page) => verifyEncKey(encKey, page))) {
                              stats.verified += 1
                              options.onProgress?.('runtime key matched')
                              return { key: cand.encKeyHex, stats }
                            }
                          }
                        }
                      }
                    }
                  }
                }
                pos = data.indexOf(pattern, pos + 1)
              }
            }
          }
          offset += chunk
        }
        await yieldEventLoop()
      }
    } finally {
      CloseHandle(handle)
    }
  }
  return { key: null, stats, error: `4.1 runtime scan miss needles=${stats.needles} nodes=${stats.nodes} candidates=${stats.candidates}` }
}

export function contactDbPagePath(dbPath: string, wxid: string): string {
  return join(dbPath, wxid, 'db_storage', 'contact', 'contact.db')
}
