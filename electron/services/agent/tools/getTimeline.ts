/**
 * get_timeline —— 按时间顺序读取某会话在指定时间窗内的消息原文。
 * 适合"某天/某段时间聊了啥""把这段对话讲清楚"。读原微信库（经 chatService → wcdb 代理）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { compactMessage, evidenceFromMessage, resolveSenders, msToSeconds, parseOnDate, coerceToolTimeMs, toLocalTime } from './shared'

export const getTimeline = tool({
  description:
    '按时间顺序读取某个会话在指定时间窗内的连续消息原文，适合"某天/某段时间聊了什么""把这段对话讲清楚"。' +
    '必须指定 sessionId（先用 list_contacts 拿 username）。查昨天/某号/某天时优先传 onDate（如 yesterday 或 2026-09-13），不要自己换算毫秒时间戳。' +
    '不给时间范围则取最近的一段。时间跨度大时只返回该窗口内最新的若干条，不要一次扫整群历史。总结优先缩到某一天。' +
    '只读单个会话的连续时间线；跨会话找内容用 search_messages / semantic_search。',
  inputSchema: z.object({
    sessionId: z.string().describe('会话 username（来自 list_contacts）'),
    onDate: z.string().optional().describe('本地日历日期：yesterday/today/2026-09-13/9月13日/13号。查某天时优先用这个'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳；有 onDate 时忽略'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳；留空表示到现在；有 onDate 时忽略'),
    limit: z.number().int().min(1).max(200).default(50).describe('返回条数上限'),
  }),
  execute: async ({ sessionId, onDate, startTimeMs, endTimeMs, limit }) => {
    try {
      const dayRange = parseOnDate(onDate)
      const resolvedStartMs = dayRange?.startTimeMs ?? coerceToolTimeMs(startTimeMs)
      const resolvedEndMs = dayRange?.endTimeMs ?? coerceToolTimeMs(endTimeMs) ?? Date.now()
      const effectiveLimit = onDate ? Math.max(limit, 100) : limit

      const { chatService } = await import('../../chatService')
      const res = await chatService.getMessagesByTimeRangeForSummary(sessionId, {
        startTime: msToSeconds(resolvedStartMs),
        endTime: msToSeconds(resolvedEndMs) ?? Math.floor(Date.now() / 1000),
        limit: effectiveLimit,
      })
      if (!res.success) return { error: res.error || '读取时间线失败' }

      const ordered = (res.messages || [])
        .slice()
        .sort((a, b) => a.sortSeq - b.sortSeq || a.createTime - b.createTime || a.localId - b.localId)
      const senderMap = await resolveSenders(ordered.map((m) => m.senderUsername || ''))
      const messages = ordered.map((m) => compactMessage(m, senderMap.get(m.senderUsername || '')))
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
            ? `该窗口内没有消息。会话最新一条是 ${toLocalTime(latest.createTime)}，请核对 onDate / 时间窗，或换 lastTime 更近的同名联系人。`
            : '该窗口内没有消息，也没有读到这个会话的任何记录。请换 list_contacts 里 lastTime 最近的那个 username。',
        }
      }
      return {
        sessionId,
        range,
        hasMore: !!res.hasMore,
        messages,
        evidence: messages.map((message) => evidenceFromMessage(sessionId, message)),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
