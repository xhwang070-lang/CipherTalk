/**
 * inspect_chat_file —— 读取微信聊天文件消息对应的本地 Excel 单元格。
 * 不是看图，也不是让模型猜表格：打开 msg/file 里已下载的 .xlsx，按工作表返回格子原文。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { describeToolError } from './shared'

function fileNameFromMessage(message: {
  fileName?: string
  parsedContent?: string
}): string {
  const named = String(message.fileName || '').trim()
  if (named) return named
  const parsed = String(message.parsedContent || '').trim()
  const tagged = parsed.match(/^\[文件\]\s*(.+)$/)
  if (tagged?.[1]) return tagged[1].trim()
  return ''
}

export const inspectChatFile = tool({
  description:
    '读取微信聊天记录里已下载到本地的 Excel 表格内容。打开的是单元格原文，不是 AI 识别，不要编造表里没有的数字。' +
    '优先：search_messages 找到文件消息后，把 sessionId 和 localId 原样传入。' +
    '如果只有文件名，也可以只传 fileName。多工作表时先看返回的 sheetNames，再带 sheetName 分次读取。' +
    '只支持 .xlsx/.xlsm/.csv；老版 .xls 和未在微信里下载的文件会明确报错。PDF 第一期不读。',
  inputSchema: z.object({
    sessionId: z.string().optional().describe('会话 username（search_messages 命中的 sessionId / anchor.sessionId）'),
    localId: z.coerce.number().optional().describe('文件消息 localId（命中消息或 anchor.localId）'),
    fileName: z.string().optional().describe('文件名，例如 价格表（可用量）9.6号.xlsx；不知道 localId 时用这个'),
    sheetName: z.string().optional().describe('工作表名；不填读第一个表'),
    maxRows: z.coerce.number().int().min(1).max(200).default(80).describe('最多返回多少行'),
  }),
  execute: async ({ sessionId, localId, fileName, sheetName, maxRows }) => {
    try {
      const { chatService } = await import('../../chatService')
      const { previewChatFile } = await import('../../chat/fileExtract')
      let message: Awaited<ReturnType<typeof chatService.getMessageByLocalId>>['message'] | undefined
      if (sessionId && localId != null && Number.isFinite(localId) && localId > 0) {
        const got = await chatService.getMessageByLocalId(sessionId, localId)
        if (got.success) message = got.message
        else if (!fileName) {
          return {
            error: got.error || '找不到这条消息',
            hint: '请先 search_messages 找到文件消息，再传入命中的 sessionId 和 localId；或直接传 fileName。',
          }
        }
      }
      const resolvedName = String(fileName || (message ? fileNameFromMessage(message) : '')).trim()
      if (!resolvedName) {
        return {
          error: '这条不是文件消息，或没有文件名',
          hint: '请对聊天里的 Excel 文件消息调用，或直接传入 fileName。',
        }
      }
      const preview = await previewChatFile({
        sessionId,
        localId,
        message,
        fileName: resolvedName,
        fileExt: message?.fileExt,
        createTime: message?.createTime,
        sheetName,
        maxRows,
      })
      const extraHint = preview.sheetNames.length > 1 && !sheetName
        ? `这个工作簿有多个表：${preview.sheetNames.join('、')}。当前只返回了第一张。要看其他表请再调用并传入 sheetName。`
        : undefined
      return {
        sessionId: sessionId || undefined,
        localId: localId || undefined,
        fileName: preview.fileName,
        exists: preview.exists,
        kind: preview.kind,
        sheetNames: preview.sheetNames,
        sheet: preview.sheet,
        truncated: preview.sheet?.truncated || false,
        error: preview.error,
        hint: preview.hint || extraHint,
        note: preview.success ? '下列数字来自 Excel 单元格，不是模型识别。' : undefined,
      }
    } catch (error) {
      return { error: describeToolError(error, 'inspect_chat_file 执行失败') }
    }
  },
})
