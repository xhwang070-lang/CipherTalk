/**
 * 按日历窗口把一个会话的消息读全，再按天分页给模型。
 * 不在 SQL 里用 create_time 过滤（大表会扫崩）；用 sort_seq 从新往旧翻，直到窗口起点。
 */
import type { Message } from '../../chatService'
import { reportAgentProgress } from '../progress'
import {
  coerceToolTimeMs,
  compactMessage,
  parseOnDate,
  resolveSenders,
  toLocalTime,
  type CompactMessage,
} from './shared'

export const PERIOD_MESSAGE_CAP = 8000
export const PERIOD_PAGE_MESSAGE_BUDGET = 180

export type PeriodCursor = {
  cursorDay: string
  afterSortSeq?: number
  afterCreateTime?: number
  afterLocalId?: number
}

export type PeriodRange = {
  startTimeMs: number
  endTimeMs: number
  label: string
}

export type PeriodDayBucket = {
  date: string
  count: number
  voices: number
  files: number
  images: number
  messages: Array<CompactMessage & { kind?: string; fileName?: string }>
}

type PeriodCache = {
  sessionId: string
  startTimeMs: number
  endTimeMs: number
  messages: Message[]
  complete: boolean
  capHit: boolean
  loadedAt: number
}

const CACHE_TTL_MS = 15 * 60 * 1000
const caches = new Map<string, PeriodCache>()

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function localDateFromCreateTime(createTime: number): string {
  const ms = createTime > 1e12 ? createTime : createTime * 1000
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function cacheKey(sessionId: string, startTimeMs: number, endTimeMs: number): string {
  return `${sessionId}|${startTimeMs}|${endTimeMs}`
}

function localDayEnd(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime()
}

function localDayStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

/** 今天 / 昨天 / 近一周 / 近一个月 / 本月 / 某天。查总结范围用这个，不要让模型自己换 epoch。 */
export function parsePeriod(input?: string | null, now = new Date()): PeriodRange | null {
  const raw = String(input || '').trim()
  if (!raw) return null
  const text = raw.replace(/\s+/g, '').toLowerCase()
  const todayEnd = localDayEnd(now.getTime())
  const todayStart = localDayStart(now.getTime())

  const lastDays = (days: number, label: string): PeriodRange => ({
    startTimeMs: localDayStart(todayStart - (days - 1) * 24 * 60 * 60 * 1000),
    endTimeMs: todayEnd,
    label,
  })

  if (['today', '今天', '今日'].includes(text)) {
    return { startTimeMs: todayStart, endTimeMs: todayEnd, label: 'today' }
  }
  if (['yesterday', '昨天', '昨日'].includes(text)) {
    const y = localDayStart(todayStart - 24 * 60 * 60 * 1000)
    return { startTimeMs: y, endTimeMs: localDayEnd(y), label: 'yesterday' }
  }
  if (text === '前天') {
    const d = localDayStart(todayStart - 2 * 24 * 60 * 60 * 1000)
    return { startTimeMs: d, endTimeMs: localDayEnd(d), label: 'day-before' }
  }
  if (['last_3_days', '近3天', '近三天', '最近三天', '这三天'].includes(text)) {
    return lastDays(3, 'last_3_days')
  }
  if (['last_7_days', '近一周', '最近一周', '这一周', '这周', '过去一周'].includes(text)) {
    return lastDays(7, 'last_7_days')
  }
  if (['last_30_days', '近一个月', '最近一个月', '近一月', '最近一月', '过去一个月'].includes(text)) {
    return lastDays(30, 'last_30_days')
  }
  if (['last_90_days', '近3个月', '近三个月', '最近三个月'].includes(text)) {
    return lastDays(90, 'last_90_days')
  }
  if (text === 'this_month' || text === '本月' || text === '这个月' || text === '一个月') {
    return {
      startTimeMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      endTimeMs: todayEnd,
      label: 'this_month',
    }
  }
  if (text === 'last_month' || text === '上个月' || text === '上月') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    return { startTimeMs: start.getTime(), endTimeMs: end.getTime(), label: 'last_month' }
  }
  const single = parseOnDate(raw, now)
  if (single) {
    return { startTimeMs: single.startTimeMs, endTimeMs: single.endTimeMs, label: single.label }
  }
  return null
}

function messageKind(msg: Message): 'text' | 'voice' | 'image' | 'video' | 'file' | 'other' {
  const text = String(msg.parsedContent || '')
  if (msg.voiceDuration || msg.localType === 34 || /\[语音/.test(text)) return 'voice'
  if (msg.fileName || msg.localType === 49) return 'file'
  if (msg.imageMd5 || msg.localType === 3) return 'image'
  if (msg.videoMd5 || msg.videoDuration || msg.localType === 43) return 'video'
  if (!text.trim()) return 'other'
  return 'text'
}

export function compactPeriodMessage(msg: Message, senderName?: string) {
  const kind = messageKind(msg)
  const base = compactMessage(msg, senderName, 280)
  const fileName = msg.fileName || undefined
  let text = base.text
  if (kind === 'voice' && !/语音/.test(text)) text = text ? `[语音消息] ${text}` : '[语音消息]'
  if (kind === 'file' && fileName && !text.includes(fileName)) text = text ? `[文件] ${fileName} ${text}` : `[文件] ${fileName}`
  if (kind === 'image' && !/\[图片/.test(text)) text = text || '[图片]'
  if (kind === 'video' && !/\[视频/.test(text)) text = text || '[视频]'
  return { ...base, text, kind, fileName }
}

export async function loadPeriodMessages(opts: {
  sessionId: string
  startTimeMs: number
  endTimeMs: number
  query?: string
}): Promise<{ messages: Message[]; complete: boolean; capHit: boolean }> {
  const key = cacheKey(opts.sessionId, opts.startTimeMs, opts.endTimeMs)
  const cached = caches.get(key)
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return { messages: cached.messages, complete: cached.complete, capHit: cached.capHit }
  }

  const { chatService } = await import('../../chatService')
  const startTime = Math.floor(opts.startTimeMs / 1000)
  const endTime = Math.floor(opts.endTimeMs / 1000)
  const collected: Message[] = []
  let cursor: { sortSeq: number; createTime: number; localId: number } | undefined
  let complete = false
  let capHit = false

  while (collected.length < PERIOD_MESSAGE_CAP) {
    reportAgentProgress({
      stage: 'searching',
      title: '正在按时间把聊天记录读全',
      detail: opts.query || '',
      sessionId: opts.sessionId,
      messagesScanned: collected.length,
    })
    const res = await chatService.getMessagesByTimeRangeForSummary(opts.sessionId, {
      startTime,
      endTime,
      limit: 200,
      beforeCursor: cursor,
    })
    if (!res.success) {
      if (collected.length > 0) break
      throw new Error(res.error || '读取时间线失败')
    }
    const page = res.messages || []
    if (page.length === 0) {
      complete = !res.hasMore
      break
    }
    collected.push(...page)
    const oldest = page[0]
    cursor = { sortSeq: oldest.sortSeq, createTime: oldest.createTime, localId: oldest.localId }
    if (!res.hasMore) {
      complete = true
      break
    }
    if (collected.length >= PERIOD_MESSAGE_CAP) {
      capHit = true
      complete = false
      break
    }
  }

  collected.sort((a, b) => a.sortSeq - b.sortSeq || a.createTime - b.createTime || a.localId - b.localId)
  const record: PeriodCache = {
    sessionId: opts.sessionId,
    startTimeMs: opts.startTimeMs,
    endTimeMs: opts.endTimeMs,
    messages: collected,
    complete,
    capHit,
    loadedAt: Date.now(),
  }
  caches.set(key, record)
  return { messages: collected, complete, capHit }
}

export async function buildPeriodPage(opts: {
  sessionId: string
  startTimeMs: number
  endTimeMs: number
  label: string
  cursor?: PeriodCursor
  maxDays?: number
  query?: string
}) {
  const loaded = await loadPeriodMessages(opts)
  const senderMap = await resolveSenders(loaded.messages.map((m) => m.senderUsername || ''))
  const byDay = new Map<string, Message[]>()
  for (const msg of loaded.messages) {
    const date = localDateFromCreateTime(msg.createTime)
    const list = byDay.get(date) || []
    list.push(msg)
    byDay.set(date, list)
  }
  const days = Array.from(byDay.keys()).sort()
  const coverAllDays = !opts.cursor && days.length > 1
  const maxDays = coverAllDays ? days.length : Math.max(1, Math.min(opts.maxDays || 7, 8))
  const perDayCap = coverAllDays
    ? Math.max(8, Math.floor(PERIOD_PAGE_MESSAGE_BUDGET / Math.max(days.length, 1)))
    : PERIOD_PAGE_MESSAGE_BUDGET
  let dayIndex = 0
  let msgIndex = 0
  if (opts.cursor?.cursorDay) {
    const found = days.indexOf(opts.cursor.cursorDay)
    dayIndex = found >= 0 ? found : 0
    if (opts.cursor.afterSortSeq != null) {
      const list = byDay.get(days[dayIndex]) || []
      const after = list.findIndex((m) =>
        m.sortSeq === opts.cursor!.afterSortSeq
        && m.createTime === (opts.cursor!.afterCreateTime ?? m.createTime)
        && m.localId === (opts.cursor!.afterLocalId ?? m.localId),
      )
      msgIndex = after >= 0 ? after + 1 : 0
      if (msgIndex >= list.length) {
        dayIndex += 1
        msgIndex = 0
      }
    }
  }

  const pageDays: PeriodDayBucket[] = []
  let used = 0
  let nextCursor: PeriodCursor | null = null

  while (dayIndex < days.length && pageDays.length < maxDays && used < PERIOD_PAGE_MESSAGE_BUDGET) {
    const date = days[dayIndex]
    const all = byDay.get(date) || []
    const slice = all.slice(msgIndex)
    const room = PERIOD_PAGE_MESSAGE_BUDGET - used
    const take = slice.slice(0, Math.min(room, coverAllDays ? perDayCap : room))
    const compacted = take.map((m) => compactPeriodMessage(m, senderMap.get(m.senderUsername || '')))
    pageDays.push({
      date,
      count: all.length,
      voices: compacted.filter((m) => m.kind === 'voice').length,
      files: compacted.filter((m) => m.kind === 'file').length,
      images: compacted.filter((m) => m.kind === 'image').length,
      messages: compacted,
    })
    used += take.length
    if (msgIndex + take.length < all.length) {
      const last = take[take.length - 1]
      if (!nextCursor) {
        nextCursor = {
          cursorDay: date,
          afterSortSeq: last.sortSeq,
          afterCreateTime: last.createTime,
          afterLocalId: last.localId,
        }
      }
      if (!coverAllDays) break
      dayIndex += 1
      msgIndex = 0
      continue
    }
    dayIndex += 1
    msgIndex = 0
    if (!coverAllDays && dayIndex < days.length && (pageDays.length >= maxDays || used >= PERIOD_PAGE_MESSAGE_BUDGET)) {
      if (!nextCursor) nextCursor = { cursorDay: days[dayIndex] }
      break
    }
  }

  if (!nextCursor && dayIndex < days.length) {
    nextCursor = { cursorDay: days[dayIndex] }
  }

  const first = loaded.messages[0]
  const last = loaded.messages[loaded.messages.length - 1]
  const remainingDays = nextCursor
    ? days.length - days.indexOf(nextCursor.cursorDay)
    : 0

  return {
    sessionId: opts.sessionId,
    range: {
      label: opts.label,
      start: toLocalTime(opts.startTimeMs),
      end: toLocalTime(opts.endTimeMs),
    },
    coverage: {
      complete: loaded.complete && !nextCursor,
      windowComplete: loaded.complete,
      capHit: loaded.capHit,
      loadedCount: loaded.messages.length,
      dayCount: days.length,
      remainingDays,
      oldest: first ? toLocalTime(first.createTime) : null,
      newest: last ? toLocalTime(last.createTime) : null,
    },
    days: pageDays,
    nextCursor,
    hint: nextCursor
      ? `本页日期：${pageDays.map((d) => d.date).join('、')}。窗口还没读完，必须带 nextCursor 再调，把剩下的天/条写完。没翻完不准说整周/整月已经总结完。`
      : loaded.complete
        ? `窗口内 ${loaded.messages.length} 条已经读完，按天写全即可。语音/文件只列出，除非用户要求转写或读表。`
        : `已读 ${loaded.messages.length} 条就到上限了，更早的还没进来。正文里写清覆盖到哪一天，不要装完整。`,
  }
}

export function resolvePeriodRange(opts: {
  period?: string
  onDate?: string
  startTimeMs?: number
  endTimeMs?: number
}): PeriodRange {
  const fromPeriod = parsePeriod(opts.period) || parsePeriod(opts.onDate)
  if (fromPeriod) return fromPeriod
  const start = coerceToolTimeMs(opts.startTimeMs)
  const end = coerceToolTimeMs(opts.endTimeMs) ?? Date.now()
  if (start && end) {
    return { startTimeMs: start, endTimeMs: end, label: 'custom' }
  }
  throw new Error('请传 period（今天/昨天/近一周/近一个月/本月）或 onDate，不要自己换毫秒时间戳')
}
