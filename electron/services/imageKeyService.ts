import crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type ImageKeyResult = {
  success: boolean
  xorKey?: number
  aesKey?: string
  error?: string
}

function cleanWxid(wxid: string): string {
  const trimmed = String(wxid || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

function isImageMagic(dec: Buffer): boolean {
  return (
    (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) ||
    (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) ||
    (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) ||
    (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) ||
    (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46)
  )
}

/**
 * Windows 图片密钥：只从磁盘推算（kvcomm + 缩略图），不扫微信进程。
 */
class ImageKeyService {
  private findTemplateDatFiles(rootDir: string): string[] {
    const files: string[] = []
    const stack = [rootDir]
    const maxFiles = 48

    while (stack.length && files.length < maxFiles) {
      const dir = stack.pop() as string
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry)
        let stats: fs.Stats
        try {
          stats = fs.statSync(fullPath)
        } catch {
          continue
        }
        if (stats.isDirectory()) {
          stack.push(fullPath)
        } else if (entry.endsWith('_t.dat')) {
          files.push(fullPath)
          if (files.length >= maxFiles) break
        }
      }
    }

    if (!files.length) return []

    const dateReg = /(\d{4}-\d{2})/
    files.sort((a, b) => {
      const ma = a.match(dateReg)?.[1]
      const mb = b.match(dateReg)?.[1]
      if (ma && mb) return mb.localeCompare(ma)
      return 0
    })

    return files.slice(0, 24)
  }

  private getXorKey(templateFiles: string[]): number | null {
    const counts = new Map<string, number>()

    for (const file of templateFiles) {
      try {
        const bytes = fs.readFileSync(file)
        if (bytes.length < 2) continue
        const x = bytes[bytes.length - 2]
        const y = bytes[bytes.length - 1]
        const key = `${x}_${y}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      } catch { /* ignore */ }
    }

    if (!counts.size) return null

    let mostKey = ''
    let mostCount = 0
    counts.forEach((count, key) => {
      if (count > mostCount) {
        mostCount = count
        mostKey = key
      }
    })

    if (!mostKey) return null
    const [xStr, yStr] = mostKey.split('_')
    const x = Number(xStr)
    const y = Number(yStr)
    const xorKey = x ^ 0xFF
    const check = y ^ 0xD9
    return xorKey === check ? xorKey : null
  }

  private getCiphertextFromTemplate(templateFiles: string[]): Buffer | null {
    for (const file of templateFiles) {
      try {
        const bytes = fs.readFileSync(file)
        if (bytes.length < 0x1f) continue
        if (
          bytes[0] === 0x07 &&
          bytes[1] === 0x08 &&
          bytes[2] === 0x56 &&
          bytes[3] === 0x32 &&
          bytes[4] === 0x08 &&
          bytes[5] === 0x07
        ) {
          return bytes.subarray(0x0f, 0x1f)
        }
      } catch { /* ignore */ }
    }
    return null
  }

  private collectWxidCandidates(userDir: string): string[] {
    const names = new Set<string>()
    const push = (raw: string) => {
      const trimmed = String(raw || '').trim()
      if (!trimmed) return
      names.add(trimmed)
      const cleaned = cleanWxid(trimmed)
      if (cleaned) names.add(cleaned)
    }
    push(path.basename(userDir))
    push(path.basename(path.dirname(userDir)))
    return [...names]
  }

  private collectKvcommDirs(): string[] {
    const home = os.homedir()
    const roots = [
      path.join(home, 'AppData', 'Roaming', 'Tencent', 'xwechat'),
      path.join(home, 'AppData', 'Roaming', 'Tencent', 'WeChat')
    ]
    const dirs: string[] = []
    for (const root of roots) {
      if (!fs.existsSync(root)) continue
      const stack = [root]
      let seen = 0
      while (stack.length && seen < 400) {
        const dir = stack.pop() as string
        seen += 1
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const full = path.join(dir, entry.name)
          if (entry.name.toLowerCase() === 'kvcomm') dirs.push(full)
          else stack.push(full)
        }
      }
    }
    return dirs
  }

  private collectKvcommCodes(): number[] {
    const codes = new Set<number>()
    const patterns = [
      /^key_(\d+)_/i,
      /^(\d+)_\d+_/
    ]
    for (const dir of this.collectKvcommDirs()) {
      let files: string[]
      try {
        files = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const file of files) {
        if (!/\.statistic$/i.test(file) && !file.toLowerCase().startsWith('key_')) continue
        for (const pattern of patterns) {
          const match = file.match(pattern)
          if (!match) continue
          const code = Number(match[1])
          if (Number.isFinite(code) && code >= 0 && code <= 0xFFFFFFFF) {
            codes.add(code)
          }
        }
      }
    }
    return [...codes]
  }

  private verifyAesKey(aesKey: string, ciphertext: Buffer): boolean {
    try {
      const keyBytes = Buffer.from(aesKey, 'ascii').subarray(0, 16)
      if (keyBytes.length < 16) return false
      const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes, null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return isImageMagic(dec)
    } catch {
      return false
    }
  }

  async getImageKeysFromDisk(
    userDir: string,
    onProgress?: (msg: string) => void
  ): Promise<ImageKeyResult> {
    onProgress?.('正在从本地缓存推算图片密钥...')
    const templateFiles = this.findTemplateDatFiles(userDir)
    if (templateFiles.length === 0) {
      return { success: false, error: '未找到图片缓存，可能该账号还没有下载过图片' }
    }

    const xorFromFile = this.getXorKey(templateFiles)
    const ciphertext = this.getCiphertextFromTemplate(templateFiles)
    const codes = this.collectKvcommCodes()
    const wxids = this.collectWxidCandidates(userDir)

    if (!ciphertext) {
      if (xorFromFile === null) {
        return { success: false, error: '未找到 V2 图片，也无法计算 XOR' }
      }
      return { success: true, xorKey: xorFromFile }
    }

    onProgress?.(`找到 ${codes.length} 个 kvcomm 候选，正在校验...`)
    for (const code of codes) {
      for (const wxid of wxids) {
        const xorKey = code & 0xFF
        const aesKey = crypto.createHash('md5').update(`${code}${wxid}`).digest('hex').substring(0, 16)
        if (!this.verifyAesKey(aesKey, ciphertext)) continue
        if (xorFromFile !== null && xorFromFile !== xorKey) continue
        onProgress?.('图片密钥已从本地缓存推算成功')
        return { success: true, xorKey, aesKey }
      }
    }

    if (xorFromFile !== null) {
      return {
        success: false,
        xorKey: xorFromFile,
        error: 'XOR 已从图片算出，但 AES 未能从 kvcomm 匹配。未扫描微信内存。'
      }
    }
    return { success: false, error: '未能从本地缓存推算图片密钥' }
  }

  async getImageKeys(
    userDir: string,
    onProgress?: (msg: string) => void
  ): Promise<ImageKeyResult> {
    return this.getImageKeysFromDisk(userDir, onProgress)
  }
}

export const imageKeyService = new ImageKeyService()
