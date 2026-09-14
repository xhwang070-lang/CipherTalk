/**
 * 华记工作日志：记录「用户 <-> 华记」今天办了什么。
 * 和微信好友日记分开。文件在 memory-bank/huaji-work-logs/YYYY-MM-DD.md。
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
  if (source === 'wechat' || source === 'wechat-persona') return '微信机器人'
  return '软件内'
}

function compactText(value: string, max = 80): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function formatClock(ms: number): string {
  const date = new Date(ms)
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

function textFromUiMessageJson(raw: string): string {
  try {
    const message = JSON.parse(raw)
    const parts = Array.isArray(message.parts) ? message.parts : []
    const texts: string[] = []
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      if (typeof part.text === 'string' && part.text.trim()) texts.push(part.text)
    }
    return compactText(texts.join(' '), 120)
  } catch {
    return ''
  }
}

function header(date: string): string {
  return [
    '# ' + date + ' 华记工作日志',
    '',
    '这是你和华记之间的工作台账，不是微信好友的日记。问「我今天让你办过什么」时看这里。',
    '',
    '## 今天让华记办的事',
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
    const at = entry.at || Date.now()
    const date = localDateKey(at)
    const file = workLogPath(date)
    if (!existsSync(file)) writeFileSync(file, header(date), 'utf8')
    const ok = entry.ok !== false
    const tools = entry.tools && entry.tools.length ? ' · 工具 ' + entry.tools.join(', ') : ''
    const line = '- ' + formatClock(at) + ' [' + sourceLabel(entry.source) + '] ' + compactText(entry.question, 72) + ' → ' + (ok ? '完成' : '失败') + ' · ' + compactText(entry.result, 72) + tools
    appendFileSync(file, line + '\n', 'utf8')
  } catch {
    // 工作日志失败不影响主回答。
  }
}

export async function rebuildHuajiWorkLog(date = localDateKey()): Promise<HuajiWorkLogInfo> {
  const { start, end } = localDayRange(date)
  const lines: string[] = []
  try {
    const { agentConversationStore } = await import('./conversationStore')
    const turns = agentConversationStore.listTurnsBetween(start, end)
    let currentId = 0
    let lastUser = ''
    for (const turn of turns) {
      if (turn.conversationId !== currentId) {
        currentId = turn.conversationId
        lastUser = ''
      }
      if (turn.role === 'user' && turn.text) {
        lastUser = turn.text
        continue
      }
      if (turn.role === 'assistant' && lastUser) {
        const failed = /失败|超时|没有返回内容|嘎了/.test(turn.text)
        lines.push('- ' + formatClock(turn.createdAt) + ' [' + sourceLabel(turn.source) + '] ' + compactText(lastUser, 72) + ' → ' + (failed ? '失败' : '完成') + ' · ' + compactText(turn.text, 72))
        lastUser = ''
      }
    }
  } catch {
    // 对话库读不到时仍写空台账，方便界面展示。
  }

  const content = header(date) + (lines.length ? lines.join('\n') + '\n' : '- 今天还没有和华记办过事。\n')
  const file = workLogPath(date)
  writeFileSync(file, content, 'utf8')
  return { date: date, content: content.trim(), path: file }
}

export function listHuajiWorkLogs(limit = 14): HuajiWorkLogInfo[] {
  const dir = workLogDir()
  const names = existsSync(dir)
    ? readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().reverse().slice(0, Math.max(1, limit))
    : []
  return names.map((name) => {
    const date = name.slice(0, 10)
    return readHuajiWorkLog(date)
  }).filter((item): item is HuajiWorkLogInfo => Boolean(item))
}

export function textFromStoredMessage(raw: string): string {
  return textFromUiMessageJson(raw)
}
