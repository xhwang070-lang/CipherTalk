/**
 * 从指定一场微信聊天里提取待办。只看这一场，不扫全库。
 * 人名、金额、承诺必须能在原文里对上；对不上就标待核。
 */
import { chatService } from '../chatService'
import { localDateKey } from './huajiWorkLog'
import {
  addHuajiTodo,
  listHuajiTodos,
  tomorrowDateKey,
  type HuajiTodoItem,
  type HuajiTodoWhen,
} from './huajiTodos'
import { compactMessage, resolveSenders, toLocalTime } from './tools/shared'
import type { Message } from '../chat/types'

export type ChatTodoCandidate = {
  username: string
  displayName: string
  kind: 'person' | 'group' | 'official'
  lastTimestamp: number
}

export type ExtractTodoRange = 'today' | 'tomorrow' | 'days7'

export type ExtractedChatTodo = {
  title: string
  when: HuajiTodoWhen
  evidence: string
  unverified: boolean
}

export type ExtractChatTodosResult = {
  ok: boolean
  person: string
  sessionId?: string
  date: string
  range: ExtractTodoRange
  added: HuajiTodoItem[]
  skipped: number
  candidates?: ChatTodoCandidate[]
  message?: string
}

const ACTION_RE = /报价|打样|发货|货期|核对|确认|改合同|合同号|下单|转账|到货|安排|公差|催货|付款|尾款|对账|发图纸|发合同|交货|周期|合同|图纸|样品|法兰|开票|发票|材质|数量|改一下|发我|发给我|帮我|你看下|确认一下|尽快|转了|打款/
const MONEY_RE = /\d+(?:\.\d+)?\s*元/
const TIME_RE = /今天|今日|明天|明日|后天|货期|周期|\d+\s*天/
const FILE_RE = /\.(?:xlsx|xls|pdf|docx|dwg|png|jpg)(?:\b|$)/i
const NOISE_RE = /^(好的?|收到|嗯+|哦+|哈+|谢谢|谢谢你|傻逼|打你|早安|晚安|在吗|ok|OK|\[图片\]|\[语音消息\]|\[视频\]|\[动画表情\]|\[位置\].*)[。！!～~]*$/i
const RANGE_RE = /^(今天|今日|明天|明日|这7天|近7天|最近7天|近一周|最近一周|这一周|本周|这几天|最近)$/
const COMMAND_PREFIX_RE = /^(?:把我和|提取|记一下我和|把)/
const COMMAND_SUFFIX_RE = /(?:记下来|记一下|整理一下|提取一下)$/

export function parseTodoExtractCommand(text: string): { person: string; range: ExtractTodoRange } | null {
  let value = String(text || '').replace(/\s+/g, '').trim()
  if (!value) return null
  if (!COMMAND_PREFIX_RE.test(value) || !value.includes('的待办')) return null
  value = value.replace(COMMAND_PREFIX_RE, '').replace(COMMAND_SUFFIX_RE, '')
  let range: ExtractTodoRange = 'today'
  const ranged = value.match(/^(.*?)(今天|今日|明天|明日|这7天|近7天|最近7天|近一周|最近一周|这一周|本周|这几天|最近)的待办$/)
  if (ranged && ranged[1] !== undefined) {
    value = ranged[1]
    range = normalizeExtractRange(ranged[2])
  } else if (value.endsWith('的待办')) {
    value = value.slice(0, -3)
  } else {
    return null
  }
  const person = value.replace(/^(?:和|与)/, '').replace(RANGE_RE, '').trim()
  if (!person || person.length > 40) return null
  if (RANGE_RE.test(person)) return null
  return { person, range }
}

function normalizeExtractRange(raw: string): ExtractTodoRange {
  if (/明天|明日/.test(raw)) return 'tomorrow'
  if (/7天|一周|本周/.test(raw)) return 'days7'
  return 'today'
}

function rangeWindow(range: ExtractTodoRange, now = Date.now()): { startTime: number; endTime: number; label: string; days: number } {
  const endTime = Math.floor(now / 1000)
  const days = range === 'days7' ? 7 : range === 'tomorrow' ? 3 : 3
  return {
    startTime: endTime - days * 24 * 60 * 60,
    endTime,
    label: range === 'days7' ? '近7天' : range === 'tomorrow' ? '近3天' : '近3天',
    days,
  }
}

function classifyContact(username: string): ChatTodoCandidate['kind'] {
  const id = String(username || '')
  if (id.endsWith('@chatroom')) return 'group'
  if (id.startsWith('gh_')) return 'official'
  return 'person'
}

export async function searchTodoChatCandidates(query: string): Promise<ChatTodoCandidate[]> {
  const q = String(query || '').trim()
  if (!q) return []
  const { dbAdapter } = await import('../dbAdapter')
  const cols = await dbAdapter.all<{ name: string }>('contact', '', 'PRAGMA table_info(contact)')
  const colSet = new Set(cols.map((c) => c.name))
  if (!colSet.has('username')) return []
  const selectCols = ['username', 'remark', 'nick_name', 'alias'].filter((c) => colSet.has(c))
  const likeCols = ['remark', 'nick_name', 'alias', 'username'].filter((c) => colSet.has(c))
  if (likeCols.length === 0) return []
  const where = likeCols.map((c) => `${c} LIKE ?`).join(' OR ')
  const rows = await dbAdapter.all<Record<string, unknown>>('contact', '', `SELECT ${selectCols.join(', ')} FROM contact WHERE ${where} LIMIT ?`, [
    ...likeCols.map(() => `%${q}%`),
    30,
  ])
  const lastByUser = new Map<string, number>()
  try {
    const sessions = await chatService.getSessions(0, 400)
    for (const session of sessions.success ? sessions.sessions || [] : []) {
      if (session.username && session.lastTimestamp) {
        lastByUser.set(session.username, Number(session.lastTimestamp) || 0)
      }
    }
  } catch {
    // 最近聊天时间只用于排序。
  }
  const seen = new Set<string>()
  return rows
    .map((row): ChatTodoCandidate => {
      const username = String(row.username || '').trim()
      return {
        username,
        displayName: String(row.remark || row.nick_name || row.alias || username).trim() || username,
        kind: classifyContact(username),
        lastTimestamp: lastByUser.get(username) || 0,
      }
    })
    .filter((item) => {
      if (!item.username || item.kind === 'official' || seen.has(item.username)) return false
      seen.add(item.username)
      return true
    })
    .sort((a, b) => {
      const rank = (item: ChatTodoCandidate) => {
        if (item.displayName === q || item.username === q) return 0
        if (item.displayName.startsWith(q) || item.username.startsWith(q)) return 1
        return 2
      }
      return rank(a) - rank(b) || b.lastTimestamp - a.lastTimestamp || a.displayName.localeCompare(b.displayName, 'zh-CN')
    })
    .slice(0, 8)
}

function guessWhen(text: string, fallback: HuajiTodoWhen): HuajiTodoWhen {
  if (/明天|明日|后天|两天后|货期|周期/.test(text)) return 'tomorrow'
  if (/今天|今日|现在|马上|尽快/.test(text)) return 'today'
  return fallback
}

function looksLikeOtherPerson(text: string, person: string): boolean {
  const names = text.match(/[\u4e00-\u9fff]{2,4}(?=说|那边|公司|总|工)/g) || []
  return names.some((name) => name !== person && name !== '我们' && name !== '他们')
}

function messageText(message: Message): string {
  const compact = compactMessage(message)
  const pieces = [
    compact.text,
    message.fileName || '',
    message.quotedContent || '',
  ].map((item) => String(item || '').replace(/\s+/g, ' ').trim())
  return pieces.filter(Boolean).join(' ').trim()
}

function isTodoText(text: string): boolean {
  if (!text || NOISE_RE.test(text)) return false
  if (ACTION_RE.test(text) || MONEY_RE.test(text) || FILE_RE.test(text)) return true
  return TIME_RE.test(text) && /发|改|看|回|确认|安排|到/.test(text)
}

function extractFromMessages(person: string, messages: Array<{ fromMe: boolean; text: string }>, fallback: HuajiTodoWhen): ExtractedChatTodo[] {
  const found: ExtractedChatTodo[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    const text = String(message.text || '').replace(/\s+/g, ' ').trim()
    if (text.length < 2 || text.length > 180) continue
    if (!isTodoText(text)) continue
    const title = (message.fromMe ? '' : person + '：') + text
    const key = title.replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    found.push({
      title: title.slice(0, 80),
      when: guessWhen(text, fallback),
      evidence: text.slice(0, 120),
      unverified: looksLikeOtherPerson(text, person),
    })
  }
  return found.slice(-12)
}

function alreadyHave(title: string): boolean {
  const needle = title.replace(/\s+/g, '')
  return listHuajiTodos('all').some((item) => {
    if (item.done) return false
    const have = item.title.replace(/\s+/g, '')
    return have === needle || have.includes(needle) || needle.includes(have)
  })
}

async function readSessionMessages(sessionId: string, range: ExtractTodoRange): Promise<Message[]> {
  const window = rangeWindow(range)
  const res = await chatService.getMessagesByTimeRangeForSummary(sessionId, {
    startTime: window.startTime,
    endTime: window.endTime,
    limit: range === 'days7' ? 200 : 120,
  })
  if (!res.success) throw new Error(res.error || '读取聊天失败')
  return (res.messages || []).slice().sort((a, b) => a.sortSeq - b.sortSeq || a.createTime - b.createTime || a.localId - b.localId)
}

export async function extractChatTodos(input: {
  person: string
  sessionId?: string
  range?: ExtractTodoRange
  when?: HuajiTodoWhen
  date?: string
}): Promise<ExtractChatTodosResult> {
  const person = String(input.person || '').trim()
  const range: ExtractTodoRange = input.range || (input.when === 'tomorrow' ? 'tomorrow' : 'today')
  const fallbackWhen: HuajiTodoWhen = range === 'tomorrow' ? 'tomorrow' : 'today'
  const date = input.date || localDateKey()
  const empty = { ok: false, person, date, range, added: [] as HuajiTodoItem[], skipped: 0 }
  if (!person) return { ...empty, message: '没有说是哪一场聊天' }

  let sessionId = String(input.sessionId || '').trim()
  let displayName = person
  if (!sessionId) {
    const candidates = await searchTodoChatCandidates(person)
    if (candidates.length === 0) {
      return { ...empty, message: '没有找到「' + person + '」对应的好友或群。' }
    }
    const exact = candidates.filter((item) => item.displayName === person || item.username === person)
    const picked = exact.length === 1 ? exact[0] : (candidates.length === 1 ? candidates[0] : null)
    if (!picked) {
      return {
        ...empty,
        candidates,
        message: '找到多个「' + person + '」，请回复编号选一场。',
      }
    }
    sessionId = picked.username
    displayName = picked.displayName
  }

  let usedRange = range
  let ordered: Message[] = []
  try {
    ordered = await readSessionMessages(sessionId, usedRange)
    if (ordered.length === 0 && usedRange !== 'days7') {
      usedRange = 'days7'
      ordered = await readSessionMessages(sessionId, usedRange)
    }
  } catch (error) {
    return { ...empty, person: displayName, sessionId, message: error instanceof Error ? error.message : String(error) }
  }

  const senderMap = await resolveSenders(ordered.map((m) => m.senderUsername || ''))
  const messages = ordered.map((m) => ({
    fromMe: compactMessage(m, senderMap.get(m.senderUsername || '')).fromMe,
    text: messageText(m),
  }))
  if (messages.length === 0) {
    const latestRes = await chatService.getMessages(sessionId, 0, 1)
    const latest = latestRes.success ? (latestRes.messages || []).slice(-1)[0] : undefined
    return {
      ...empty,
      ok: false,
      person: displayName,
      sessionId,
      message: latest
        ? '这一场这段时间没有聊天。最新一条是 ' + (toLocalTime(latest.createTime) || '更早') + '。'
        : '这一场没有读到聊天记录。',
    }
  }

  let extracted = extractFromMessages(displayName, messages, fallbackWhen)
  if (extracted.length === 0 && usedRange !== 'days7') {
    usedRange = 'days7'
    ordered = await readSessionMessages(sessionId, usedRange)
    const nextSenders = await resolveSenders(ordered.map((m) => m.senderUsername || ''))
    extracted = extractFromMessages(displayName, ordered.map((m) => ({
      fromMe: compactMessage(m, nextSenders.get(m.senderUsername || '')).fromMe,
      text: messageText(m),
    })), fallbackWhen)
  }

  const added: HuajiTodoItem[] = []
  let skipped = 0
  for (const item of extracted) {
    if (alreadyHave(item.title)) {
      skipped += 1
      continue
    }
    added.push(addHuajiTodo({
      title: item.title,
      when: item.when,
      source: 'chat',
      person: displayName,
      sessionId,
      unverified: item.unverified,
      evidence: item.evidence,
    }))
  }
  const windowLabel = usedRange === 'days7' ? '近7天' : '最近'
  if (added.length === 0) {
    return {
      ok: true,
      person: displayName,
      sessionId,
      date,
      range: usedRange,
      added,
      skipped,
      message: skipped
        ? '这些待办本子里已经有了。'
        : '和「' + displayName + '」' + windowLabel + '没有抽出可记的待办。可以说「把我和' + displayName + '这7天的待办记下来」。',
    }
  }
  return { ok: true, person: displayName, sessionId, date, range: usedRange, added, skipped }
}

export function formatExtractChatTodos(result: ExtractChatTodosResult): string {
  if (!result.ok && result.candidates && result.candidates.length > 1) {
    return result.message + '\n' + result.candidates.map((item, index) => (index + 1) + '. ' + item.displayName).join('\n')
  }
  if (!result.ok) return result.message || '提取失败'
  if (result.added.length === 0) return result.message || '没有新的待办'
  const label = result.range === 'days7' ? '近7天' : '最近'
  const lines = ['已从「' + result.person + '」' + label + '记下 ' + result.added.length + ' 条：']
  for (const item of result.added) {
    lines.push((item.due === tomorrowDateKey() ? '明天 ' : '今天 ') + (item.unverified ? '待核 ' : '') + item.title)
  }
  if (result.skipped) lines.push('另有 ' + result.skipped + ' 条已经在本子里。')
  return lines.join('\n')
}
