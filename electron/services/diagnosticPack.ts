import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import os from 'os'
import { app, shell } from 'electron'
const AdmZip: any = require('adm-zip')
import { getAppVersion, getUserDataPath } from './runtimePaths'
import { getWxKeyScanLogPath } from '../main/elevation'

const MAX_FILE_BYTES = 6 * 1024 * 1024
const FORBIDDEN_NAME = /all_keys|token\.json|huaji-config|\.db$|\.sqlite/i

export type DiagnosticPackResult = {
  success: boolean
  path?: string
  files?: string[]
  error?: string
}

function desktopDir(): string {
  try {
    return app.getPath('desktop')
  } catch {
    return join(os.homedir(), 'Desktop')
  }
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function dayStamp(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function sanitizeDiagnosticText(text: string): string {
  return text
    .replace(/x'[0-9a-fA-F]{64,192}'/g, "x'<HEX>'")
    .replace(/0x[0-9a-fA-F]{64}/gi, '0x<HEX64>')
    .replace(/[0-9a-fA-F]{64}/g, '<HEX64>')
    .replace(/\b(enc_key|dbKey|decryptKey|apiKey|api_key|secret|password|token)\b\s*[:=]\s*["']?[^"'\s,}\]]+/gi, '$1=<REDACTED>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <REDACTED>')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '<REDACTED_KEY>')
}

function readLogTail(filePath: string): string | null {
  if (!existsSync(filePath) || FORBIDDEN_NAME.test(basename(filePath))) return null
  try {
    const size = statSync(filePath).size
    if (size <= 0) return ''
    if (size <= MAX_FILE_BYTES) return readFileSync(filePath, 'utf8')
    const fd = require('fs').openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES)
      require('fs').readSync(fd, buf, 0, MAX_FILE_BYTES, size - MAX_FILE_BYTES)
      return `[truncated head, last ${MAX_FILE_BYTES} bytes]\n` + buf.toString('utf8')
    } finally {
      require('fs').closeSync(fd)
    }
  } catch {
    return null
  }
}

function collectLogPaths(): Array<{ name: string; path: string }> {
  const userData = getUserDataPath()
  const logsDir = join(userData, 'logs')
  const out: Array<{ name: string; path: string }> = []
  const add = (name: string, filePath: string) => {
    if (!filePath || !existsSync(filePath)) return
    if (FORBIDDEN_NAME.test(basename(filePath))) return
    if (out.some((item) => item.path === filePath)) return
    out.push({ name, path: filePath })
  }

  add('wxkey-scan.log', getWxKeyScanLogPath())
  add('wxkey-scan.log', join(userData, 'wxkey-scan.log'))
  add('logs/startup.log', join(logsDir, 'startup.log'))
  add('logs/startup.log.old', join(logsDir, 'startup.log.old'))

  const days = [0, -1, -2].map((offset) => dayStamp(offset))
  for (const day of days) {
    add(`logs/huaji-${day}.log`, join(logsDir, `huaji-${day}.log`))
    add(`logs/ciphertalk-${day}.log`, join(logsDir, `ciphertalk-${day}.log`))
  }

  if (existsSync(logsDir)) {
    try {
      for (const name of readdirSync(logsDir)) {
        if (!/^huaji-\d{4}-\d{2}-\d{2}\.log$/i.test(name) && !/^startup\.log/i.test(name)) continue
        add(`logs/${name}`, join(logsDir, name))
      }
    } catch {
      /* ignore */
    }
  }
  return out
}

export function exportDiagnosticPack(): DiagnosticPackResult {
  try {
    const files = collectLogPaths()
    const included: string[] = []
    const zip = new AdmZip()
    const meta = {
      app: 'Huaji',
      version: getAppVersion(),
      platform: process.platform,
      arch: process.arch,
      createdAt: new Date().toISOString(),
      userData: getUserDataPath(),
      note: 'Sanitized logs only. No all_keys.json, chat databases, or tokens.',
      files: [] as string[],
    }

    for (const item of files) {
      const raw = readLogTail(item.path)
      if (raw == null) continue
      const body = sanitizeDiagnosticText(raw)
      zip.addFile(item.name.replace(/\\/g, '/'), Buffer.from(body, 'utf8'))
      included.push(item.name)
    }

    meta.files = included
    zip.addFile('meta.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'))
    zip.addFile(
      'README.txt',
      Buffer.from(
        [
          'Huaji diagnostic pack',
          '',
          'Contains sanitized app logs only.',
          'Does not include all_keys.json, chat databases, or tokens.',
          '64-char hex keys are replaced with <HEX64>.',
          '',
          `Version: ${meta.version}`,
          `Created: ${meta.createdAt}`,
        ].join('\n'),
        'utf8',
      ),
    )

    const dir = desktopDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const outPath = join(dir, `Huaji-diag-${meta.version}-${stamp()}.zip`)
    zip.writeZip(outPath)
    try {
      shell.showItemInFolder(outPath)
    } catch {
      void shell.openPath(dir)
    }
    return { success: true, path: outPath, files: included }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
