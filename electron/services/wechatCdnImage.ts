/**
 * 从微信消息 XML 里的 CDN 地址拉原图（不需要先在微信里点开）。
 * 仅用于当前账号自己的聊天图片；密钥来自本地消息。
 */
import https from 'https'
import http from 'http'
import crypto from 'crypto'
import { detectImageExtension } from './datDecryptCore'

export interface WechatCdnImageInfo {
  md5?: string
  aesKey?: string
  cdnBigUrl?: string
  cdnMidUrl?: string
  cdnThumbUrl?: string
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

function attr(content: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i')
  const match = re.exec(content)
  return match ? decodeHtml(match[1].trim()) : ''
}

export function parseWechatCdnImageInfo(content: string): WechatCdnImageInfo {
  if (!content) return {}
  const xml = content.replace(/<live>[\s\S]*?<\/live>/gi, '')
  return {
    md5: (attr(xml, 'md5') || attr(xml, 'fullmd5')).toLowerCase() || undefined,
    aesKey: attr(content, 'aeskey') || undefined,
    cdnBigUrl: attr(content, 'cdnbigimgurl') || attr(content, 'cdnbigimgurl_') || attr(content, 'hd_url') || undefined,
    cdnMidUrl: attr(content, 'cdnmidimgurl') || attr(content, 'cdnmidimgurl_') || undefined,
    cdnThumbUrl: attr(content, 'cdnthumburl') || attr(content, 'cdnthumburl_') || undefined,
  }
}

function looksLikeImage(buffer: Buffer): boolean {
  return Boolean(detectImageExtension(buffer))
}

function tryAesDecrypt(buffer: Buffer, aesKey: string): Buffer | null {
  const hex = aesKey.replace(/\s+/g, '')
  const keys: Buffer[] = []
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length >= 32) {
    keys.push(Buffer.from(hex.slice(0, 32), 'hex'))
  }
  if (aesKey.length >= 16) keys.push(Buffer.from(aesKey, 'utf8').subarray(0, 16))
  try {
    const b64 = Buffer.from(aesKey, 'base64')
    if (b64.length >= 16) keys.push(b64.subarray(0, 16))
  } catch { /* ignore */ }

  for (const key of keys) {
    if (key.length !== 16) continue
    for (const mode of ['aes-128-ecb', 'aes-128-cbc'] as const) {
      try {
        const iv = mode === 'aes-128-cbc' ? key : null
        const decipher = crypto.createDecipheriv(mode, key, iv)
        decipher.setAutoPadding(true)
        const decoded = Buffer.concat([decipher.update(buffer), decipher.final()])
        if (looksLikeImage(decoded)) return decoded
      } catch { /* next */ }
    }
  }
  return null
}

function fetchBuffer(url: string, timeoutMs = 20000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === 'http:' ? http : https
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'MicroMessenger Client',
        Accept: '*/*',
      },
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
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('CDN 下载超时'))
    })
    req.on('error', reject)
    req.end()
  })
}

export async function downloadWechatCdnImage(info: WechatCdnImageInfo): Promise<Buffer | null> {
  const urls = [info.cdnBigUrl, info.cdnMidUrl].map((item) => String(item || '').trim()).filter(Boolean)
  for (const url of urls) {
    try {
      const raw = await fetchBuffer(url)
      if (!raw.length) continue
      if (looksLikeImage(raw)) return raw
      if (info.aesKey) {
        const decoded = tryAesDecrypt(raw, info.aesKey)
        if (decoded) return decoded
      }
    } catch (error) {
      console.warn('[WechatCdnImage] 下载失败', url.slice(0, 80), error instanceof Error ? error.message : String(error))
    }
  }
  return null
}
