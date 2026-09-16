import { execSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

export type UnlockPdfResult =
  | { ok: true; buffer: Buffer; changed: boolean }
  | { ok: false; needsPassword: boolean; error: string }

export function isPdfBuffer(buffer: Buffer | undefined | null): buffer is Buffer {
  return Boolean(buffer && buffer.length > 8 && buffer.subarray(0, 5).toString('latin1') === '%PDF-')
}

export function isPdfEncrypted(buffer: Buffer): boolean {
  if (!isPdfBuffer(buffer)) return false
  return buffer.includes(Buffer.from('/Encrypt'))
}

function qpdfCandidates(): string[] {
  const exe = process.platform === 'win32' ? 'qpdf.exe' : 'qpdf'
  const roots: string[] = []
  const push = (dir: string) => {
    if (dir) roots.push(dir)
  }
  try {
    push(join(__dirname, '..', '..', '..', 'resources', 'qpdf', 'bin'))
    push(join(__dirname, '..', '..', '..', 'resources', 'qpdf'))
    push(join(__dirname, '..', '..', 'resources', 'qpdf', 'bin'))
    push(join(__dirname, '..', '..', 'resources', 'qpdf'))
    push(join(process.cwd(), 'resources', 'qpdf', 'bin'))
    push(join(process.cwd(), 'resources', 'qpdf'))
  } catch {
    // ignore
  }
  if (process.resourcesPath) {
    push(join(process.resourcesPath, 'resources', 'qpdf', 'bin'))
    push(join(process.resourcesPath, 'resources', 'qpdf'))
    push(join(process.resourcesPath, 'qpdf', 'bin'))
    push(join(process.resourcesPath, 'qpdf'))
    push(join(process.resourcesPath, 'assets', 'qpdf'))
    push(join(process.resourcesPath, 'app', 'resources', 'qpdf', 'bin'))
  }
  try {
    const exeDir = dirname(process.execPath)
    push(join(exeDir, 'resources', 'resources', 'qpdf', 'bin'))
    push(join(exeDir, 'resources', 'qpdf', 'bin'))
    push(join(exeDir, 'resources', 'qpdf'))
    push(join(exeDir, 'resources', 'assets', 'qpdf'))
  } catch {
    // ignore
  }
  return [...new Set(roots.map((root) => join(root, exe)))]
}

export function resolveQpdfPath(): string | null {
  for (const candidate of qpdfCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  if (process.platform === 'win32') {
    try {
      const found = String(execSync('where qpdf', { encoding: 'utf8', windowsHide: true }))
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item && existsSync(item))
      if (found) return found
    } catch {
      // not on PATH
    }
  }
  return null
}

function runQpdfDecrypt(inputPath: string, outputPath: string): { ok: boolean; stderr: string; status: number | null } {
  const qpdf = resolveQpdfPath()
  if (!qpdf) return { ok: false, stderr: 'missing qpdf', status: null }
  const result = spawnSync(qpdf, ['--decrypt', inputPath, outputPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  return {
    ok: result.status === 0 && existsSync(outputPath),
    stderr: String(result.stderr || result.stdout || ''),
    status: typeof result.status === 'number' ? result.status : null,
  }
}

function looksLikePasswordError(text: string): boolean {
  return /password|invalid password|needs a password|encrypted/i.test(text) && /invalid|incorrect|required|needed|wrong/i.test(text)
}

export function unlockPdfBuffer(buffer: Buffer): UnlockPdfResult {
  if (!isPdfBuffer(buffer)) return { ok: false, needsPassword: false, error: '不是 PDF 文件' }
  if (!isPdfEncrypted(buffer)) return { ok: true, buffer, changed: false }

  const dir = mkdtempSync(join(tmpdir(), 'huaji-pdf-'))
  const inputPath = join(dir, 'in.pdf')
  const outputPath = join(dir, 'out.pdf')
  try {
    writeFileSync(inputPath, buffer)
    const ran = runQpdfDecrypt(inputPath, outputPath)
    if (ran.ok) {
      const next = readFileSync(outputPath)
      if (!isPdfBuffer(next)) return { ok: false, needsPassword: false, error: '解密结果不是 PDF' }
      return { ok: true, buffer: next, changed: isPdfEncrypted(buffer) && !isPdfEncrypted(next) }
    }
    if (looksLikePasswordError(ran.stderr) || /password/i.test(ran.stderr)) {
      return { ok: false, needsPassword: true, error: '这份 PDF 有打开密码，没有密码解不了' }
    }
    return { ok: false, needsPassword: false, error: ran.stderr.trim() || '解密失败' }
  } catch (error) {
    return { ok: false, needsPassword: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function unlockedPdfFilename(name: string): string {
  const base = String(name || 'document.pdf').replace(/[\\/:*?"<>|]/g, '_').trim() || 'document.pdf'
  if (/-无密码\.pdf$/i.test(base)) return base
  return base.replace(/\.pdf$/i, '') + '-无密码.pdf'
}


export function writeUnlockedPdfFile(buffer: Buffer, filename: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'huaji-pdf-out-'))
  const filePath = join(dir, unlockedPdfFilename(filename))
  writeFileSync(filePath, buffer)
  return filePath
}
