/**
 * 华记本地备忘：按人/按单写在 memory-bank/huaji-memos，不上传。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { memoryDatabase } from './memory/memoryDatabase'

export type HuajiMemo = {
  id: string
  title: string
  body: string
  person?: string
  orderNo?: string
  updatedAt: string
  path: string
}

const DIR_NAME = 'huaji-memos'

function memoDir(): string {
  const dir = join(memoryDatabase.getMemoryBankPath(), DIR_NAME)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function safeName(value: string): string {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'memo'
}

function parseMemo(filePath: string, fileName: string): HuajiMemo | null {
  if (!existsSync(filePath)) return null
  const raw = readFileSync(filePath, 'utf8')
  const title = (raw.match(/^title:\s*"(.*)"/m) || raw.match(/^#\s+(.+)$/m) || [])[1] || fileName.replace(/\.md$/, '')
  const person = (raw.match(/^person:\s*"(.*)"/m) || [])[1] || ''
  const orderNo = (raw.match(/^order:\s*"(.*)"/m) || [])[1] || ''
  const updatedAt = (raw.match(/^updated:\s*"(.*)"/m) || [])[1] || ''
  const body = raw.replace(/^---[\s\S]*?---\s*/, '').replace(/^# .+\n+/, '').trim()
  return {
    id: fileName,
    title: String(title || '').trim() || fileName,
    body,
    person: person || undefined,
    orderNo: orderNo || undefined,
    updatedAt,
    path: filePath,
  }
}

export function listHuajiMemos(limit = 50): HuajiMemo[] {
  const dir = memoDir()
  const names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort().reverse().slice(0, Math.max(1, limit))
  return names.map((name) => parseMemo(join(dir, name), name)).filter((item): item is HuajiMemo => Boolean(item))
}

export function writeHuajiMemo(input: { title: string; body: string; person?: string; orderNo?: string; id?: string }): HuajiMemo {
  const title = String(input.title || '').trim()
  if (!title) throw new Error('备忘标题不能空')
  const stamp = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const updated = `${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())} ${p(stamp.getHours())}:${p(stamp.getMinutes())}`
  const id = String(input.id || '').trim() || `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}-${safeName(title)}.md`
  const fileName = id.endsWith('.md') ? id : id + '.md'
  const filePath = join(memoDir(), fileName)
  const content = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    'type: memo',
    'source: huaji',
    input.person ? `person: "${String(input.person).replace(/"/g, '\\"')}"` : '',
    input.orderNo ? `order: "${String(input.orderNo).replace(/"/g, '\\"')}"` : '',
    `updated: "${updated}"`,
    '---',
    '',
    `# ${title}`,
    '',
    String(input.body || '').trim(),
    '',
  ].filter((line, index, lines) => line !== '' || index === 0 || index === lines.length - 1).join('\n')
  writeFileSync(filePath, content, 'utf8')
  return parseMemo(filePath, fileName) as HuajiMemo
}

export function deleteHuajiMemo(id: string): boolean {
  const fileName = String(id || '').trim()
  if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return false
  const filePath = join(memoDir(), fileName.endsWith('.md') ? fileName : fileName + '.md')
  if (!existsSync(filePath)) return false
  unlinkSync(filePath)
  return true
}

export function memosDirectory(): string {
  return memoDir()
}
