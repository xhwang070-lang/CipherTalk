/**
 * read_period —— 按天把一个会话在「近一周 / 近一个月 / 某天」里的消息读全。
 * 一次只返回有限几天，必须带 nextCursor 翻完。不要用 search_messages 做月总结。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { describeToolError } from './shared'
import { buildPeriodPage, resolvePeriodRange, type PeriodCursor } from './periodMessages'

export const readPeriod = tool({
  description:
    '按天读取某个会话在一个日历窗口内的连续聊天原文，用于一天/一周/一个月的完整总结。' +
    '必须先 list_contacts 拿 sessionId。period 用 近一周 / 近一个月 / 本月 / 上个月 / yesterday / 2026-09-13。' +
    '一次只给几天原文，返回 nextCursor 时必须原样再调，直到 coverage.complete=true。' +
    '没翻完不准说整周或整月。语音和文件只带标记和文件名，除非用户要求转写或读表。' +
    '超过一周的完整总结写完后用 save_chat_summary 存成本地文件。',
  inputSchema: z.object({
    sessionId: z.string().describe('会话 username，来自 list_contacts，同名选 lastTime 最近的'),
    period: z.string().optional().describe('今天 / 昨天 / 近一周 / 近一个月 / 本月 / 上个月 / last_7_days / last_30_days。必须跟用户原话一致'),
    onDate: z.string().optional().describe('单日：yesterday/today/2026-09-13；和 period 二选一'),
    startTimeMs: z.number().optional().describe('自定义起点毫秒；能用 period/onDate 就不要填'),
    endTimeMs: z.number().optional().describe('自定义终点毫秒'),
    cursorDay: z.string().optional().describe('nextCursor.cursorDay，原样传入'),
    afterSortSeq: z.number().optional().describe('nextCursor.afterSortSeq，原样传入'),
    afterCreateTime: z.number().optional().describe('nextCursor.afterCreateTime，原样传入'),
    afterLocalId: z.number().optional().describe('nextCursor.afterLocalId，原样传入'),
    maxDays: z.number().int().min(1).max(7).default(7).describe('这一页最多返回几天。用户说今天时 1 天即可；近一周不要只取 1 天。'),
  }),
  execute: async ({
    sessionId,
    period,
    onDate,
    startTimeMs,
    endTimeMs,
    cursorDay,
    afterSortSeq,
    afterCreateTime,
    afterLocalId,
    maxDays,
  }) => {
    try {
      const range = resolvePeriodRange({ period, onDate, startTimeMs, endTimeMs })
      const cursor: PeriodCursor | undefined = cursorDay
        ? {
            cursorDay,
            afterSortSeq,
            afterCreateTime,
            afterLocalId,
          }
        : undefined
      return await buildPeriodPage({
        sessionId,
        startTimeMs: range.startTimeMs,
        endTimeMs: range.endTimeMs,
        label: range.label,
        cursor,
        maxDays,
        query: period || onDate || range.label,
      })
    } catch (error) {
      return { error: describeToolError(error, 'read_period 执行失败') }
    }
  },
})
