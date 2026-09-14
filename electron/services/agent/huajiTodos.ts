/**
 * 华记待办：一个本子，按到期日分成今天 / 明天。
 * 不自动从全部微信聊天里挖待办，避免串人。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { memoryDatabase } from '../memory/memoryDatabase'
import { localDateKey } from './huajiWorkLog'

export type HuajiTodoWhen = 'today' | 'tomorrow'
export type HuajiTodoSource = 'user' | 'chat' | 'worklog'

export type HuajiTodoItem = {
  id: string
  title: string
  due: string
  done: boolean
  source: HuajiTodoSource
  person?: string
  sessionId?: string
  localId?: number
  fileName?: string
  unverified?: boolean
  evidence?: string
  createdAt: number
  doneAt?: number
}

type TodoFile = { items: HuajiTodoItem[]; lastMorningPush?: string }

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function shiftDate(date: string, days: number): string {
  const parts = date.split('-').map((item) => Number(item))
  const next = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1)
  next.setDate(next.getDate() + days)
  return localDateKey(next.getTime())
}

export function tomorrowDateKey(from = localDateKey()): string {
  return shiftDate(from, 1)
}

function todoPath(): string {
  const dir = memoryDatabase.getMemoryBankPath()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'huaji-todos.json')
}

function readFile(): TodoFile {
  const file = todoPath()
  if (!existsSync(file)) return { items: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as TodoFile
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      lastMorningPush: typeof parsed.lastMorningPush === 'string' ? parsed.lastMorningPush : undefined,
    }
  } catch {
    return { items: [] }
  }
}

function writeFile(data: TodoFile): void {
  writeFileSync(todoPath(), JSON.stringify({ items: data.items, lastMorningPush: data.lastMorningPush || undefined }, null, 2), 'utf8')
}

function newId(): string {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export function rolloverHuajiTodos(today = localDateKey()): number {
  const data = readFile()
  let moved = 0
  for (const item of data.items) {
    if (item.done) continue
    if (item.due && item.due < today) {
      item.due = today
      moved += 1
    }
  }
  if (moved) writeFile(data)
  return moved
}

export function listHuajiTodos(when?: HuajiTodoWhen | 'all'): HuajiTodoItem[] {
  rolloverHuajiTodos()
  const today = localDateKey()
  const tomorrow = tomorrowDateKey(today)
  const items = readFile().items.filter((item) => {
    if (when === 'today') return item.due === today
    if (when === 'tomorrow') return item.due === tomorrow
    return true
  })
  return items.sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt)
}

export function addHuajiTodo(input: {
  title: string
  when?: HuajiTodoWhen
  source?: HuajiTodoSource
  person?: string
  sessionId?: string
  localId?: number
  fileName?: string
  unverified?: boolean
  evidence?: string
}): HuajiTodoItem {
  const title = String(input.title || '').replace(/\s+/g, ' ').trim()
  if (!title) throw new Error('待办内容不能为空')
  const today = localDateKey()
  const item: HuajiTodoItem = {
    id: newId(),
    title: title.slice(0, 80),
    due: input.when === 'tomorrow' ? tomorrowDateKey(today) : today,
    done: false,
    source: input.source || 'user',
    person: input.person ? String(input.person).trim().slice(0, 40) : undefined,
    sessionId: input.sessionId ? String(input.sessionId).trim() : undefined,
    localId: Number(input.localId || 0) > 0 ? Number(input.localId) : undefined,
    fileName: input.fileName ? String(input.fileName).trim().slice(0, 180) : undefined,
    unverified: input.unverified ? true : undefined,
    evidence: input.evidence ? String(input.evidence).replace(/\s+/g, ' ').trim().slice(0, 120) : undefined,
    createdAt: Date.now(),
  }
  const data = readFile()
  data.items.unshift(item)
  writeFile(data)
  return item
}

export function completeHuajiTodo(idOrTitle: string): HuajiTodoItem | null {
  const query = String(idOrTitle || '').trim()
  if (!query) return null
  const data = readFile()
  const item = data.items.find((row) => !row.done && (row.id === query || row.title.indexOf(query) >= 0 || query.indexOf(row.title) >= 0))
    || data.items.find((row) => row.id === query)
  if (!item) return null
  item.done = true
  item.doneAt = Date.now()
  writeFile(data)
  return item
}

export function uncompleteHuajiTodo(id: string): HuajiTodoItem | null {
  const data = readFile()
  const item = data.items.find((row) => row.id === id)
  if (!item) return null
  item.done = false
  item.doneAt = undefined
  writeFile(data)
  return item
}

export function removeHuajiTodo(id: string): boolean {
  const data = readFile()
  const next = data.items.filter((row) => row.id !== id)
  if (next.length === data.items.length) return false
  writeFile({ items: next, lastMorningPush: data.lastMorningPush })
  return true
}

export function formatHuajiTodos(when: HuajiTodoWhen): string {
  const items = listHuajiTodos(when).filter((item) => !item.done)
  const label = when === 'tomorrow' ? '明日待办' : '今日待办'
  if (items.length === 0) {
    return label + '是空的。可以说「记一下，明天给xxx发报价」，或「把我和xxx今天的待办记下来」。'
  }
  return [label + '：'].concat(items.map((item, index) => {
    const mark = item.unverified ? '待核 ' : ''
    const who = item.person ? '（' + item.person + '）' : ''
    return (index + 1) + '. ' + mark + item.title + who
  })).join('\n')
}

export function consumeMorningTodoPush(today = localDateKey()): boolean {
  const data = readFile()
  if (data.lastMorningPush === today) return false
  data.lastMorningPush = today
  writeFile(data)
  return true
}

export function peekMorningTodoPush(today = localDateKey()): boolean {
  return readFile().lastMorningPush === today
}

export function parseTodoListCommand(text: string): HuajiTodoWhen | null {
  const value = String(text || '').trim()
  if (/^(?:#|\/)?(?:今天待办|今日待办)$/i.test(value)) return 'today'
  if (/^(?:#|\/)?(?:明天待办|明日待办)$/i.test(value)) return 'tomorrow'
  return null
}

export function parseTodoAddCommand(text: string): { title: string; when: HuajiTodoWhen } | null {
  const value = String(text || '').trim()
  const remind = value.match(/^(今天|明天)提醒我(.+)$/i)
  if (remind && remind[2]) {
    return { title: remind[2].trim(), when: remind[1] === '明天' ? 'tomorrow' : 'today' }
  }
  const matched = value.match(/^(?:记一下|记下|加个待办|待办)[，,：:\s]*(今天|明天)?[，,：:\s]*(.+)$/i)
  if (!matched || !matched[2]) return null
  const title = matched[2].replace(/^提醒我/, '').trim()
  if (!title) return null
  const when: HuajiTodoWhen = matched[1] === '明天' ? 'tomorrow' : 'today'
  return { title: title, when: when }
}

export function parseTodoDoneCommand(text: string): string | null {
  const value = String(text || '').trim()
  const matched = value.match(/^(?:完成待办|待办完成|搞定了|做完了)[，,：:\s]*(.+)$/i)
  if (!matched || !matched[1]) return null
  return matched[1].trim()
}


export function displayTodoPerson(person?: string): string {
  const trimmed = String(person || '').trim()
  const stripped = trimmed.replace(/\d{6,}$/g, '').replace(/[-_\s]+$/g, '').trim()
  return stripped || trimmed
}

export function inferTodoFileName(item: HuajiTodoItem): string {
  if (item.fileName) return item.fileName
  const matches = String(item.title || '').match(/[^\s\\/:*?"<>|]{2,}\.(?:docx?|pdf|xlsx|xls)/gi)
  return matches && matches.length ? matches[matches.length - 1] : ''
}

export async function openHuajiTodoFile(id: string): Promise<{ success: boolean; error?: string; path?: string }> {
  const item = listHuajiTodos('all').find((row) => row.id === id)
  if (!item) return { success: false, error: '没有这条待办' }
  const fileName = inferTodoFileName(item)
  if (!fileName) return { success: false, error: '这条待办没有文件' }
  const { ConfigService } = await import('../config')
  const { resolveChatFilePath } = await import('../chat/fileExtract')
  const { shell } = await import('electron')
  const config = new ConfigService()
  try {
    const dbPath = String(config.get('dbPath') || '').trim()
    const wxid = String(config.get('myWxid') || '').trim()
    if (!dbPath || !wxid) return { success: false, error: '还没有配置微信数据目录' }
    const filePath = resolveChatFilePath({
      dbPath,
      wxid,
      fileName,
      createTime: item.createdAt > 10_000_000_000 ? Math.floor(item.createdAt / 1000) : item.createdAt,
    })
    if (!filePath) return { success: false, error: '本地还没找到这个文件，可能微信没下载完' }
    const openError = await shell.openPath(filePath)
    if (openError) return { success: false, error: openError, path: filePath }
    return { success: true, path: filePath }
  } finally {
    config.close()
  }
}
