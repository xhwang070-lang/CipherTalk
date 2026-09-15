/**
 * 时间窗口内所有有消息的私聊/群聊，按会话翻页读原文。不要让用户一个个点名。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { normalizeTimeRange } from '../../statsSqlHelpers'
import { listSessionRanking } from './chatStats'
import { describeToolError } from './shared'
import { buildPeriodPage, resolvePeriodRange, type PeriodCursor } from './periodMessages'

export type RosterKind = 'private' | 'group'

export type RosterPeriodProgress = {
  kind: RosterKind
  complete: boolean
  peopleTotal: number
  peopleIndex: number
  currentName: string
  remaining: number
  nextCursor: {
    cursorUsername: string
    cursorDay?: string
    afterSortSeq?: number
    afterCreateTime?: number
    afterLocalId?: number
  } | null
}

let lastProgress: RosterPeriodProgress | null = null

export function getLastPrivatePeriodProgress(): RosterPeriodProgress | null {
  return lastProgress
}

type Person = { username: string; displayName: string; messageCount: number }

const peopleCache = new Map<string, { people: Person[]; at: number }>()
const PEOPLE_TTL_MS = 10 * 60 * 1000

function unitLabel(kind: RosterKind): string {
  return kind === 'group' ? '群' : '私聊'
}

function toolName(kind: RosterKind): string {
  return kind === 'group' ? 'read_group_period' : 'read_private_period'
}

async function loadPeople(kind: RosterKind, startTimeMs: number, endTimeMs: number): Promise<Person[]> {
  const key = `${kind}|${startTimeMs}|${endTimeMs}`
  const cached = peopleCache.get(key)
  if (cached && Date.now() - cached.at < PEOPLE_TTL_MS) return cached.people
  const range = normalizeTimeRange(startTimeMs, endTimeMs)
  const ranked = await listSessionRanking(range, 300, kind)
  if ('error' in ranked && ranked.error) throw new Error(String(ranked.error))
  const people = ((ranked as { rankings?: Person[] }).rankings || [])
    .filter((p) => Number(p.messageCount) > 0)
    .map((p) => ({
      username: p.username,
      displayName: p.displayName || p.username,
      messageCount: Number(p.messageCount) || 0,
    }))
  peopleCache.set(key, { people, at: Date.now() })
  return people
}

async function executeRoster(kind: RosterKind, input: {
  period?: string
  onDate?: string
  startTimeMs?: number
  endTimeMs?: number
  cursorUsername?: string
  cursorDay?: string
  afterSortSeq?: number
  afterCreateTime?: number
  afterLocalId?: number
}) {
  const range = resolvePeriodRange({ period: input.period || '近一周', onDate: input.onDate, startTimeMs: input.startTimeMs, endTimeMs: input.endTimeMs })
  const people = await loadPeople(kind, range.startTimeMs, range.endTimeMs)
  const unit = unitLabel(kind)
  if (people.length === 0) {
    lastProgress = { kind, complete: true, peopleTotal: 0, peopleIndex: 0, currentName: '', remaining: 0, nextCursor: null }
    return { complete: true, kind, peopleTotal: 0, days: [], hint: `这个时间窗口里没有${unit}消息。` }
  }

  let index = 0
  if (input.cursorUsername) {
    const found = people.findIndex((p) => p.username === input.cursorUsername)
    index = found >= 0 ? found : 0
  }
  const person = people[index]
  const dayCursor: PeriodCursor | undefined = input.cursorDay
    ? {
        cursorDay: input.cursorDay,
        afterSortSeq: input.afterSortSeq,
        afterCreateTime: input.afterCreateTime,
        afterLocalId: input.afterLocalId,
      }
    : undefined
  const page = await buildPeriodPage({
    sessionId: person.username,
    startTimeMs: range.startTimeMs,
    endTimeMs: range.endTimeMs,
    label: range.label,
    cursor: dayCursor,
    maxDays: 2,
    query: `${person.displayName} ${input.period || '近一周'}`,
  })

  let nextCursor: RosterPeriodProgress['nextCursor'] = null
  if (page.nextCursor) {
    nextCursor = {
      cursorUsername: person.username,
      cursorDay: page.nextCursor.cursorDay,
      afterSortSeq: page.nextCursor.afterSortSeq,
      afterCreateTime: page.nextCursor.afterCreateTime,
      afterLocalId: page.nextCursor.afterLocalId,
    }
  } else if (index + 1 < people.length) {
    nextCursor = { cursorUsername: people[index + 1].username }
  }

  const remaining = nextCursor
    ? people.length - people.findIndex((p) => p.username === nextCursor!.cursorUsername)
    : 0
  const complete = !nextCursor
  lastProgress = {
    kind,
    complete,
    peopleTotal: people.length,
    peopleIndex: index + 1,
    currentName: person.displayName,
    remaining,
    nextCursor,
  }

  return {
    ...page,
    kind,
    person: {
      username: person.username,
      displayName: person.displayName,
      messageCount: person.messageCount,
      index: index + 1,
      total: people.length,
    },
    rosterPreview: people.slice(0, 30).map((p, i) => ({
      index: i + 1,
      name: p.displayName,
      messages: p.messageCount,
    })),
    peopleRemaining: remaining,
    complete,
    nextCursor,
    hint: complete
      ? `全部 ${people.length} 个${unit}已经读完。按${unit}按天写全后调用 save_chat_summary。`
      : `当前第 ${index + 1}/${people.length} 个${unit}：${person.displayName}。把已返回的天写完，然后立刻再调 ${toolName(kind)}，nextCursor 原样传入。不要问用户要名字。还剩 ${remaining} 个。`,
  }
}

const rosterInput = z.object({
  period: z.string().optional().describe('近一周 / 近一个月 / 本月 / last_7_days / last_30_days'),
  onDate: z.string().optional(),
  startTimeMs: z.number().optional(),
  endTimeMs: z.number().optional(),
  cursorUsername: z.string().optional().describe('nextCursor.cursorUsername，原样传入'),
  cursorDay: z.string().optional().describe('nextCursor.cursorDay，原样传入'),
  afterSortSeq: z.number().optional(),
  afterCreateTime: z.number().optional(),
  afterLocalId: z.number().optional(),
})

export const readPrivatePeriod = tool({
  description:
    '读完近一周/近一个月里所有有消息的私聊原文。用户说「近一周私聊总结」时必须用这个，不要让用户点名，也不要只用 chat_stats。' +
    '一次只返回当前这个人的若干天。有 nextCursor 就必须原样再调，直到 complete=true。全部写完后 save_chat_summary。',
  inputSchema: rosterInput,
  execute: async (input) => {
    try {
      return await executeRoster('private', input)
    } catch (error) {
      return { error: describeToolError(error, 'read_private_period 执行失败') }
    }
  },
})

export const readGroupPeriod = tool({
  description:
    '读完近一周/近一个月里所有有消息的群聊原文。用户说「近一周群聊总结」时必须用这个，不要让用户点群名，也不要只用 chat_stats。' +
    '一次只返回当前这个群的若干天。有 nextCursor 就必须原样再调，直到 complete=true。全部写完后 save_chat_summary。',
  inputSchema: rosterInput,
  execute: async (input) => {
    try {
      return await executeRoster('group', input)
    } catch (error) {
      return { error: describeToolError(error, 'read_group_period 执行失败') }
    }
  },
})
