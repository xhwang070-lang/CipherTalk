/**
 * 华记工作日志：只记「办了什么、结果怎样」。
 * 不写完整提示词，不写英文思考过程。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { memoryDatabase } from '../memory/memoryDatabase'

export type HuajiWorkLogEntry = {
  source: 'app' | 'wechat' | string
  question: string
  result: string
  ok?: boolean
  tools?: string[]
  at?: number
  conversationId?: number
}

export type HuajiWorkLogInfo = {
  date: string
  content: string
  path: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function localDateKey(ms = Date.now()): string {
  const date = new Date(ms)
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

function localDayRange(date: string): { start: number; end: number } {
  const parts = date.split('-').map((item) => Number(item))
  const start = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1, 0, 0, 0, 0).getTime()
  return { start: start, end: start + 24 * 60 * 60 * 1000 }
}

function workLogDir(): string {
  const dir = join(memoryDatabase.getMemoryBankPath(), 'huaji-work-logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function workLogPath(date: string): string {
  return join(workLogDir(), date + '.md')
}

function sourceLabel(source?: string): string {
  if (source === 'wechat' || source === 'wechat-persona') return '微信'
  return '软件'
}

function compactText(value: string, max: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function formatClock(ms: number): string {
  const date = new Date(ms)
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

function isEnglishPlanning(text: string): boolean {
  const value = String(text || '')
  if (/The user wants|The previous|Let me |I need to |I will |I'll |The user is asking/i.test(value)) return true
  const letters = (value.match(/[A-Za-z]/g) || []).length
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length
  return letters > 28 && letters > cjk * 2
}

export function summarizeWorkQuestion(raw: string): string {
  let text = String(raw || '')
  text = text.replace(/@\S+\[[^\]]+\]\s*/g, '')
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.indexOf('请根据华记工作日志') >= 0) return ''
  if (text.indexOf('请总结我们这次对话') === 0) return ''
  const summary = text.match(/^请总结(.+?)的聊天记录/)
  if (summary && summary[1]) return compactText('总结' + summary[1], 32)
  const first = (text.split(/[。！？\n]/)[0] || text).trim()
  return compactText(first, 32)
}

export function summarizeWorkResult(raw: string): { ok: boolean; text: string } {
  let text = String(raw || '').replace(/\s+/g, ' ').trim()
  const failed = /失败|超时|没有返回内容|嘎了|没有聊天记录/.test(text)
  if (!text) return { ok: !failed, text: failed ? '失败' : '已完成' }
  if (isEnglishPlanning(text)) {
    const chinese = text.match(/[\u4e00-\u9fff][^A-Za-z]{6,80}/)
    if (chinese && chinese[0]) text = chinese[0].trim()
    else return { ok: !failed, text: failed ? '失败' : '处理中' }
  }
  const sentence = text
    .split(/[。！？\n]/)
    .map((item) => item.trim())
    .find((item) => item.length >= 4 && !isEnglishPlanning(item))
  return { ok: !failed, text: compactText(sentence || text, 36) }
}

function header(date: string): string {
  return [
    '# ' + date + ' 华记工作日志',
    '',
    '只记你让华记办的事。',
    '',
  ].join('\n')
}

function conversationLink(conversationId?: number): string {
  const id = Number(conversationId || 0)
  if (!Number.isInteger(id) || id <= 0) return ''
  return ' [打开对话](#/agent?conversation=' + id + ')'
}

function formatEntry(at: number, source: string, question: string, result: { ok: boolean; text: string }, conversationId?: number): string {
  return [
    '### ' + formatClock(at) + ' · ' + sourceLabel(source) + conversationLink(conversationId),
    question,
    (result.ok ? '完成' : '失败') + '：' + result.text,
    '',
  ].join('\n')
}

export function readHuajiWorkLog(date = localDateKey()): HuajiWorkLogInfo | null {
  const file = workLogPath(date)
  if (!existsSync(file)) return null
  const content = readFileSync(file, 'utf8').trim()
  if (!content) return null
  return { date: date, content: content, path: file }
}

export function appendHuajiWorkLogEntry(entry: HuajiWorkLogEntry): void {
  try {
    const question = summarizeWorkQuestion(entry.question)
    if (!question) return
    const at = entry.at || Date.now()
    const date = localDateKey(at)
    const file = workLogPath(date)
    if (!existsSync(file)) writeFileSync(file, header(date), 'utf8')
    const result = summarizeWorkResult(entry.result)
    if (entry.ok === false) result.ok = false
    appendFileSync(file, formatEntry(at, entry.source, question, result, entry.conversationId), 'utf8')
  } catch {
    // 工作日志失败不影响主回答。
  }
}

export async function rebuildHuajiWorkLog(date = localDateKey()): Promise<HuajiWorkLogInfo> {
  const { start, end } = localDayRange(date)
  const blocks: string[] = []
  const seen: string[] = []
  try {
    const { agentConversationStore } = await import('./conversationStore')
    const turns = agentConversationStore.listTurnsBetween(start, end)
    let currentId = 0
    let lastUser = ''
    let lastAt = 0
    let lastSource = 'app'
    for (const turn of turns) {
      if (turn.conversationId !== currentId) {
        currentId = turn.conversationId
        lastUser = ''
      }
      if (turn.role === 'user' && turn.text) {
        lastUser = turn.text
        lastAt = turn.createdAt
        lastSource = turn.source
        continue
      }
      if (turn.role === 'assistant' && lastUser) {
        const question = summarizeWorkQuestion(lastUser)
        lastUser = ''
        if (!question) continue
        const result = summarizeWorkResult(turn.text)
        const key = sourceLabel(lastSource) + '|' + question
        const lastKey = seen.length ? seen[seen.length - 1] : ''
        const block = formatEntry(turn.createdAt || lastAt, lastSource, question, result, currentId)
        if (key === lastKey && blocks.length) {
          blocks[blocks.length - 1] = block
        } else {
          seen.push(key)
          blocks.push(block)
        }
      }
    }
  } catch {
    // 对话库读不到时仍写空台账。
  }

  const content = header(date) + (blocks.length ? blocks.join('\n') : '今天还没有和华记办过事。\n')
  const file = workLogPath(date)
  writeFileSync(file, content, 'utf8')
  return { date: date, content: content.trim(), path: file }
}

export function listHuajiWorkLogs(limit = 14): HuajiWorkLogInfo[] {
  const dir = workLogDir()
  const names = existsSync(dir)
    ? readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().reverse().slice(0, Math.max(1, limit))
    : []
  return names.map((name) => readHuajiWorkLog(name.slice(0, 10))).filter((item): item is HuajiWorkLogInfo => Boolean(item))
}

export function displayHuajiWorkLog(content: string): string {
  const text = String(content || '').replace(/^# .+\n+/, '').replace(/^只记你让华记办的事。\n+/, '').trim()
  return text || '今天还没有和华记办过事。'
}

export function textFromStoredMessage(raw: string): string {
  try {
    const message = JSON.parse(raw) as { parts?: Array<{ type?: unknown; text?: unknown }> }
    const parts = Array.isArray(message.parts) ? message.parts : []
    const texts: string[] = []
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const type = String(part.type || 'text')
      if (type !== 'text') continue
      if (typeof part.text === 'string' && part.text.trim()) texts.push(part.text)
    }
    return texts.join('\n').trim()
  } catch {
    return ''
  }
}
