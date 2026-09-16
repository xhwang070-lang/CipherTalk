/**
 * 时间窗口内所有有消息的私聊/群聊，按会话翻页读原文。不要让用户一个个点名。
 * 私聊里条数少的人会打成 packedPeople 一次返回多人，避免只写活跃会话、漏掉短对话。
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
const LIGHT_MESSAGE_MAX = 40
const LIGHT_BATCH_PEOPLE = 8
const LIGHT_BATCH_MESSAGES = 180

function unitLabel(kind: RosterKind): string {
  return kind === 'group' ? '群' : '私聊'
}

function toolName(kind: RosterKind): string {
  return kind === 'group' ? 'read_group_period' : 'read_private_period'
}

function isLightPerson(person: Person): boolean {
  return person.messageCount > 0 && person.messageCount <= LIGHT_MESSAGE_MAX
}

function orderPeople(kind: RosterKind, people: Person[]): Person[] {
  if (kind !== 'private') return people
  const light = people.filter(isLightPerson)
  const heavy = people.filter((p) => !isLightPerson(p))
  return [...light, ...heavy]
}

function rosterOf(people: Person[]) {
  return people.map((p, i) => ({
    index: i + 1,
    name: p.displayName,
    messages: p.messageCount,
  }))
}

async function loadPeople(kind: RosterKind, startTimeMs: number, endTimeMs: number): Promise<Person[]> {
  const key = `${kind}|${startTimeMs}|${endTimeMs}`
  const cached = peopleCache.get(key)
  if (cached && Date.now() - cached.at < PEOPLE_TTL_MS) return cached.people
  const range = normalizeTimeRange(startTimeMs, endTimeMs)
  const ranked = await listSessionRanking(range, 300, kind)
  if ('error' in ranked && ranked.error) throw new Error(String(ranked.error))
  const people = orderPeople(
    kind,
    ((ranked as { rankings?: Person[] }).rankings || [])
      .filter((p) => Number(p.messageCount) > 0)
      .map((p) => ({
        username: p.username,
        displayName: p.displayName || p.username,
        messageCount: Number(p.messageCount) || 0,
      })),
  )
  peopleCache.set(key, { people, at: Date.now() })
  return people
}

function remainingFromCursor(people: Person[], nextCursor: RosterPeriodProgress['nextCursor']): number {
  if (!nextCursor) return 0
  const found = people.findIndex((p) => p.username === nextCursor.cursorUsername)
  return found >= 0 ? people.length - found : 0
}

function setProgress(kind: RosterKind, people: Person[], peopleIndex: number, currentName: string, nextCursor: RosterPeriodProgress['nextCursor']) {
  const remaining = remainingFromCursor(people, nextCursor)
  lastProgress = {
    kind,
    complete: !nextCursor,
    peopleTotal: people.length,
    peopleIndex,
    currentName,
    remaining,
    nextCursor,
  }
  return remaining
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

  const packLights = kind === 'private' && !dayCursor && isLightPerson(person)
  if (packLights) {
    const packedPeople: Array<{
      person: { username: string; displayName: string; messageCount: number; index: number; total: number }
      days: unknown
      coverage: unknown
    }> = []
    let used = 0
    let lastIndex = index
    let nextCursor: RosterPeriodProgress['nextCursor'] = null

    for (let i = index; i < people.length; i++) {
      const current = people[i]
      if (!isLightPerson(current)) break
      if (packedPeople.length >= LIGHT_BATCH_PEOPLE) break
      if (used >= LIGHT_BATCH_MESSAGES) break
      const page = await buildPeriodPage({
        sessionId: current.username,
        startTimeMs: range.startTimeMs,
        endTimeMs: range.endTimeMs,
        label: range.label,
        maxDays: 8,
        query: `${current.displayName} ${input.period || '近一周'}`,
      })
      const msgCount = page.days.reduce((sum, day) => sum + (day.messages?.length || 0), 0)
      packedPeople.push({
        person: {
          username: current.username,
          displayName: current.displayName,
          messageCount: current.messageCount,
          index: i + 1,
          total: people.length,
        },
        days: page.days,
        coverage: page.coverage,
      })
      used += msgCount
      lastIndex = i
      if (page.nextCursor) {
        nextCursor = {
          cursorUsername: current.username,
          cursorDay: page.nextCursor.cursorDay,
          afterSortSeq: page.nextCursor.afterSortSeq,
          afterCreateTime: page.nextCursor.afterCreateTime,
          afterLocalId: page.nextCursor.afterLocalId,
        }
        break
      }
    }
    if (!nextCursor && lastIndex + 1 < people.length) {
      nextCursor = { cursorUsername: people[lastIndex + 1].username }
    }

    const lastPerson = people[lastIndex]
    const remaining = setProgress(kind, people, lastIndex + 1, lastPerson.displayName, nextCursor)
    const packedNames = packedPeople.map((item) => item.person.displayName).join('、')
    console.warn('[read_private_period] packed light chats', {
      peopleTotal: people.length,
      packed: packedPeople.length,
      names: packedNames,
      complete: !nextCursor,
      remaining,
    })
    return {
      kind,
      person: {
        username: lastPerson.username,
        displayName: lastPerson.displayName,
        messageCount: lastPerson.messageCount,
        index: lastIndex + 1,
        total: people.length,
      },
      packedPeople,
      days: packedPeople[0]?.days || [],
      rosterPreview: rosterOf(people),
      peopleRemaining: remaining,
      complete: !nextCursor,
      nextCursor,
      hint: !nextCursor
        ? `全部 ${people.length} 个${unit}已经读完。packedPeople 里每个人都要写，条数少、只有一两句的也要写。写完 save_chat_summary。`
        : `本页打包了 ${packedPeople.length} 个低条数${unit}：${packedNames}。每个人都要写，报价/约定/待办/文件哪怕只有一句也不能省。写完立刻再调 ${toolName(kind)}，nextCursor 原样传入。不要问用户要名字。还剩 ${remaining} 个。`,
    }
  }

  const page = await buildPeriodPage({
    sessionId: person.username,
    startTimeMs: range.startTimeMs,
    endTimeMs: range.endTimeMs,
    label: range.label,
    cursor: dayCursor,
    maxDays: 7,
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

  const remaining = setProgress(kind, people, index + 1, person.displayName, nextCursor)
  console.warn(`[${toolName(kind)}] page`, {
    peopleTotal: people.length,
    index: index + 1,
    name: person.displayName,
    messages: person.messageCount,
    complete: !nextCursor,
    remaining,
  })

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
    rosterPreview: rosterOf(people),
    peopleRemaining: remaining,
    complete: !nextCursor,
    nextCursor,
    hint: !nextCursor
      ? `全部 ${people.length} 个${unit}已经读完。按${unit}按天写全后调用 save_chat_summary。条数少的人也不能省略。`
      : `当前第 ${index + 1}/${people.length} 个${unit}：${person.displayName}。把已返回的天写完，然后立刻再调 ${toolName(kind)}，nextCursor 原样传入。不要问用户要名字。还剩 ${remaining} 个。complete 为 false 时禁止说「所有私聊已经整理好了」。`,
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
    '读完近一周/近一个月里所有有消息的私聊原文。用户说「近一周私聊/私信总结」时必须用这个，不要让用户点名，也不要只用 chat_stats。折叠的聊天默认排除。' +
    '低条数的人会打成 packedPeople 一次返回多人，每个人都要写，不能只写活跃的几个。' +
    '有 nextCursor 就必须原样再调，直到 complete=true。全部写完后 save_chat_summary。',
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
    '读完近一周/近一个月里所有有消息的群聊原文。用户说「近一周群聊总结」时必须用这个，不要让用户点群名，也不要只用 chat_stats。微信「折叠的聊天」里的群默认排除。' +
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
