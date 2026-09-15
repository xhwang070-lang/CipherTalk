/**
 * read_private_period —— 时间窗口内所有有消息的私聊，按人翻页读原文。
 * 不要让用户一个个点名。一次返回一个人的若干天，必须带 nextCursor 直到 roster 翻完。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { normalizeTimeRange } from '../../statsSqlHelpers'
import { listPrivateRanking } from './chatStats'
import { describeToolError } from './shared'
import { buildPeriodPage, resolvePeriodRange, type PeriodCursor } from './periodMessages'

export type PrivatePeriodProgress = {
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

let lastProgress: PrivatePeriodProgress | null = null

export function getLastPrivatePeriodProgress(): PrivatePeriodProgress | null {
  return lastProgress
}

type Person = { username: string; displayName: string; messageCount: number }

const peopleCache = new Map<string, { people: Person[]; at: number }>()
const PEOPLE_TTL_MS = 10 * 60 * 1000

async function loadPeople(startTimeMs: number, endTimeMs: number): Promise<Person[]> {
  const key = `${startTimeMs}|${endTimeMs}`
  const cached = peopleCache.get(key)
  if (cached && Date.now() - cached.at < PEOPLE_TTL_MS) return cached.people
  const range = normalizeTimeRange(startTimeMs, endTimeMs)
  const ranked = await listPrivateRanking(range, 300)
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

export const readPrivatePeriod = tool({
  description:
    '读完近一周/近一个月里所有有消息的私聊原文。用户说「近一周私聊总结」时必须用这个，不要让用户点名，也不要只用 chat_stats。' +
    '一次只返回当前这个人的若干天。有 nextCursor 就必须原样再调，直到 complete=true / peopleRemaining=0。' +
    '按人按天写全；写完一个人再翻下一个。全部写完后 save_chat_summary。',
  inputSchema: z.object({
    period: z.string().optional().describe('近一周 / 近一个月 / 本月 / last_7_days / last_30_days'),
    onDate: z.string().optional(),
    startTimeMs: z.number().optional(),
    endTimeMs: z.number().optional(),
    cursorUsername: z.string().optional().describe('nextCursor.cursorUsername，原样传入'),
    cursorDay: z.string().optional().describe('nextCursor.cursorDay，原样传入'),
    afterSortSeq: z.number().optional(),
    afterCreateTime: z.number().optional(),
    afterLocalId: z.number().optional(),
  }),
  execute: async ({
    period,
    onDate,
    startTimeMs,
    endTimeMs,
    cursorUsername,
    cursorDay,
    afterSortSeq,
    afterCreateTime,
    afterLocalId,
  }) => {
    try {
      const range = resolvePeriodRange({ period: period || '近一周', onDate, startTimeMs, endTimeMs })
      const people = await loadPeople(range.startTimeMs, range.endTimeMs)
      if (people.length === 0) {
        lastProgress = { complete: true, peopleTotal: 0, peopleIndex: 0, currentName: '', remaining: 0, nextCursor: null }
        return { complete: true, peopleTotal: 0, days: [], hint: '这个时间窗口里没有私聊消息。' }
      }

      let index = 0
      if (cursorUsername) {
        const found = people.findIndex((p) => p.username === cursorUsername)
        index = found >= 0 ? found : 0
      }
      const person = people[index]
      const dayCursor: PeriodCursor | undefined = cursorDay
        ? { cursorDay, afterSortSeq, afterCreateTime, afterLocalId }
        : undefined
      const page = await buildPeriodPage({
        sessionId: person.username,
        startTimeMs: range.startTimeMs,
        endTimeMs: range.endTimeMs,
        label: range.label,
        cursor: dayCursor,
        maxDays: 2,
        query: `${person.displayName} ${period || '近一周'}`,
      })

      let nextCursor: PrivatePeriodProgress['nextCursor'] = null
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
        complete,
        peopleTotal: people.length,
        peopleIndex: index + 1,
        currentName: person.displayName,
        remaining,
        nextCursor,
      }

      return {
        ...page,
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
          ? `全部 ${people.length} 个私聊已经读完。按人按天写全后调用 save_chat_summary。`
          : `当前第 ${index + 1}/${people.length} 个：${person.displayName}。把这个人已返回的天写完，然后立刻再调 read_private_period，nextCursor 原样传入。不要问用户要人名。还剩 ${remaining} 人。`,
      }
    } catch (error) {
      return { error: describeToolError(error, 'read_private_period 执行失败') }
    }
  },
})
