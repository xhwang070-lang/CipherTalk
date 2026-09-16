/**
 * Download a WeChat file attachment from CDN when it was never opened locally.
 * Only HTTP(S) URLs work; WeChat 4 protobuf tokens cannot be fetched.
 */
import fs from 'fs'
import http from 'http'
import https from 'https'
import path from 'path'
import crypto from 'crypto'

export type WechatCdnAttachInfo = {
  fileName?: string
  fileSize?: number
  fileExt?: string
  fileMd5?: string
  cdnUrl?: string
  aesKey?: string
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

function xmlValue(content: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(content)
  return match ? decodeHtml(match[1].trim()) : ''
}

function xmlAttr(content: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(content)
  return match ? decodeHtml(match[1].trim()) : ''
}

function firstHttpUrl(content: string): string {
  const keys = ['cdnattachurl', 'fileurl', 'downurl', 'attachurl', 'cdnurl', 'url']
  const found: string[] = []
  for (const key of keys) {
    const value = xmlValue(content, key) || xmlAttr(content, key)
    if (value) found.push(value.trim())
  }
  return found.find((item) => /^https?:\/\//i.test(item)) || ''
}

export function parseWechatCdnAttachInfo(content: string): WechatCdnAttachInfo {
  if (!content) return {}
  const fileName = xmlValue(content, 'title') || xmlValue(content, 'filename') || xmlAttr(content, 'filename')
  const totallen = xmlValue(content, 'totallen') || xmlValue(content, 'filelen')
  const fileExt = xmlValue(content, 'fileext') || (fileName.includes('.') ? fileName.split('.').pop() : '')
  const fileMd5 = (xmlValue(content, 'md5') || xmlAttr(content, 'md5')).toLowerCase()
  const aesKey = xmlValue(content, 'aeskey') || xmlAttr(content, 'aeskey')
  return {
    fileName: fileName || undefined,
    fileSize: totallen ? Number(totallen) : undefined,
    fileExt: fileExt || undefined,
    fileMd5: fileMd5 || undefined,
    cdnUrl: firstHttpUrl(content) || undefined,
    aesKey: aesKey || undefined,
  }
}

function looksLikeDocument(buffer: Buffer): boolean {
  if (buffer.length < 4) return false
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return true
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return true
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf) return true
  return false
}

function tryDecrypt(buffer: Buffer, aesKey: string): Buffer | null {
  const hex = aesKey.replace(/\s+/g, '')
  const keys: Buffer[] = []
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length >= 32) keys.push(Buffer.from(hex.slice(0, 32), 'hex'))
  if (aesKey.length >= 16) keys.push(Buffer.from(aesKey, 'utf8').subarray(0, 16))
  try {
    const b64 = Buffer.from(aesKey, 'base64')
    if (b64.length >= 16) keys.push(b64.subarray(0, 16))
  } catch { /* ignore */ }
  for (const key of keys) {
    if (key.length !== 16) continue
    for (const mode of ['aes-128-ecb', 'aes-128-cbc'] as const) {
      try {
        const decipher = crypto.createDecipheriv(mode, key, mode === 'aes-128-cbc' ? key : null)
        decipher.setAutoPadding(true)
        const decoded = Buffer.concat([decipher.update(buffer), decipher.final()])
        if (looksLikeDocument(decoded)) return decoded
      } catch { /* next */ }
    }
  }
  return null
}

function fetchBuffer(url: string, timeoutMs = 25000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === 'http:' ? http : https
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'MicroMessenger Client', Accept: '*/*' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location, timeoutMs).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk as Buffer))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('CDN 下载超时')))
    req.on('error', reject)
    req.end()
  })
}

function safeFileName(name: string): string {
  return String(name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80)
}

export async function downloadWechatCdnAttach(info: WechatCdnAttachInfo, cacheDir: string): Promise<string | null> {
  const url = String(info.cdnUrl || '').trim()
  if (!/^https?:\/\//i.test(url)) return null
  if (info.fileSize && info.fileSize > 40 * 1024 * 1024) return null
  fs.mkdirSync(cacheDir, { recursive: true })
  const stamp = info.fileMd5 || crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)
  const fileName = safeFileName(info.fileName || `attach.${info.fileExt || 'bin'}`)
  const dest = path.join(cacheDir, `${stamp}-${fileName}`)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest
  try {
    const raw = await fetchBuffer(url)
    if (!raw.length) return null
    const decoded = looksLikeDocument(raw) ? raw : (info.aesKey ? tryDecrypt(raw, info.aesKey) : null)
    if (!decoded || !decoded.length) return null
    fs.writeFileSync(dest, decoded)
    return dest
  } catch (error) {
    console.warn('[WechatCdnAttach] 下载失败', url.slice(0, 80), error instanceof Error ? error.message : String(error))
    return null
  }
}
