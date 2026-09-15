/**
 * get_timeline —— 读某个会话某一天或一小段的连续原文。
 * 一周/一个月请用 read_period，不要用本工具截最新几十条冒充完整。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { compactMessage, evidenceFromMessage, resolveSenders, msToSeconds, parseOnDate, coerceToolTimeMs, toLocalTime } from './shared'
import { buildPeriodPage } from './periodMessages'

export const getTimeline = tool({
  description:
    '按时间顺序读取某个会话某一天的连续消息原文，适合"昨天/某号聊了什么"。' +
    '必须指定 sessionId（先用 list_contacts）。查某天传 onDate（yesterday 或 2026-09-13）。' +
    '近一周、近一个月、本月不要用本工具，改用 read_period，否则会不完整。' +
    '当天消息多时会分页，返回 nextCursor 就必须再调直到 coverage.complete。',
  inputSchema: z.object({
    sessionId: z.string().describe('会话 username（来自 list_contacts）'),
    onDate: z.string().optional().describe('本地日历日期：yesterday/today/2026-09-13/9月13日/13号'),
    startTimeMs: z.number().optional().describe('起始时间毫秒；有 onDate 时忽略'),
    endTimeMs: z.number().optional().describe('结束时间毫秒；有 onDate 时忽略'),
    cursorDay: z.string().optional().describe('nextCursor.cursorDay，原样传入'),
    afterSortSeq: z.number().optional().describe('nextCursor.afterSortSeq，原样传入'),
    afterCreateTime: z.number().optional().describe('nextCursor.afterCreateTime，原样传入'),
    afterLocalId: z.number().optional().describe('nextCursor.afterLocalId，原样传入'),
    limit: z.number().int().min(1).max(250).default(150).describe('无 onDate 时的条数上限'),
  }),
  execute: async ({
    sessionId,
    onDate,
    startTimeMs,
    endTimeMs,
    cursorDay,
    afterSortSeq,
    afterCreateTime,
    afterLocalId,
    limit,
  }) => {
    try {
      const period = parseOnDate(onDate)
      if (period) {
        const page = await buildPeriodPage({
          sessionId,
          startTimeMs: period.startTimeMs,
          endTimeMs: period.endTimeMs,
          label: period.label,
          cursor: cursorDay
            ? { cursorDay, afterSortSeq, afterCreateTime, afterLocalId }
            : undefined,
          maxDays: 1,
          query: onDate,
        })
        const messages = page.days.flatMap((day) => day.messages)
        return {
          ...page,
          messages,
          evidence: messages.map((message) => evidenceFromMessage(sessionId, message)),
        }
      }

      const resolvedStartMs = coerceToolTimeMs(startTimeMs)
      const resolvedEndMs = coerceToolTimeMs(endTimeMs) ?? Date.now()
      const { chatService } = await import('../../chatService')
      const res = await chatService.getMessagesByTimeRangeForSummary(sessionId, {
        startTime: msToSeconds(resolvedStartMs),
        endTime: msToSeconds(resolvedEndMs) ?? Math.floor(Date.now() / 1000),
        limit,
        beforeCursor: afterSortSeq != null && afterCreateTime != null && afterLocalId != null
          ? { sortSeq: afterSortSeq, createTime: afterCreateTime, localId: afterLocalId }
          : undefined,
      })
      if (!res.success) return { error: res.error || '读取时间线失败' }

      const ordered = (res.messages || [])
        .slice()
        .sort((a, b) => a.sortSeq - b.sortSeq || a.createTime - b.createTime || a.localId - b.localId)
      const senderMap = await resolveSenders(ordered.map((m) => m.senderUsername || ''))
      const messages = ordered.map((m) => compactMessage(m, senderMap.get(m.senderUsername || ''), 4000))
      const range = {
        onDate: onDate || null,
        start: toLocalTime(resolvedStartMs) || null,
        end: toLocalTime(resolvedEndMs) || null,
      }
      if (messages.length === 0) {
        const latestRes = await chatService.getMessages(sessionId, 0, 1)
        const latest = latestRes.success ? (latestRes.messages || []).slice(-1)[0] : undefined
        return {
          sessionId,
          range,
          hasMore: false,
          messages: [],
          hint: latest
            ? `该窗口内没有消息。会话最新一条是 ${toLocalTime(latest.createTime)}，请核对时间窗，或换 lastTime 更近的同名联系人。`
            : '该窗口内没有消息。请换 list_contacts 里 lastTime 最近的那个 username。',
        }
      }
      const oldest = ordered[0]
      return {
        sessionId,
        range,
        hasMore: !!res.hasMore,
        nextCursor: res.hasMore
          ? {
              cursorDay: undefined,
              afterSortSeq: oldest.sortSeq,
              afterCreateTime: oldest.createTime,
              afterLocalId: oldest.localId,
            }
          : null,
        messages,
        evidence: messages.map((message) => evidenceFromMessage(sessionId, message)),
        hint: res.hasMore ? '还没读完，必须带 nextCursor 再调 get_timeline。没翻完不准说已经总结完整。' : undefined,
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
