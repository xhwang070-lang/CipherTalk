/**
 * convert_chat_file —— 本机把聊天里的 Excel/Word/CSV/图片转成另一种格式。
 * 写出用 exceljs / docx / pdf-lib，不走云 OCR。扫描件 PDF 不能变成表格。
 */
import fs from 'fs'
import { tool } from 'ai'
import { z } from 'zod'
import { describeToolError } from './shared'
import { convertFileBuffer, parseConvertTarget, type ConvertTarget } from '../../chat/fileConvert'
import { locateOrDownloadChatFile } from '../../chat/fileExtract'

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

function normalizeTarget(raw?: string): ConvertTarget | null {
  const value = String(raw || '').trim()
  if (!value) return null
  if (value === 'xlsx' || value === 'csv' || value === 'docx' || value === 'pdf' || value === 'md') return value
  return parseConvertTarget(`转成${value}`)
}

export const convertChatFile = tool({
  description:
    '把微信聊天里已下载的 Excel / Word / CSV / 图片在本机转成另一种格式，并返回可发送的本地文件路径。' +
    '用户说「转成 Excel / Word / PDF / CSV」时用。图片只能转 PDF；中文表格请转 Word 或 Excel，不要转 PDF。' +
    '扫描件 PDF 不能变成表格。不要用云 OCR。优先 search_messages 找到文件后传入 sessionId + localId。',
  inputSchema: z.object({
    target: z.string().min(1).describe('目标格式：xlsx / csv / docx / pdf / md，或「Excel」「Word」'),
    sessionId: z.string().optional().describe('会话 username'),
    localId: z.coerce.number().optional().describe('文件消息 localId'),
    fileName: z.string().optional().describe('文件名；不知道 localId 时用这个'),
    filePath: z.string().optional().describe('已经在本机的文件绝对路径'),
  }),
  execute: async ({ target, sessionId, localId, fileName, filePath }) => {
    try {
      const wanted = normalizeTarget(target)
      if (!wanted) {
        return { error: '不知道要转成什么。可以说转成 Excel、Word、PDF 或 CSV。' }
      }
      let sourcePath = String(filePath || '').trim()
      let sourceName = String(fileName || (sourcePath ? sourcePath.split(/[\\/]/).pop() : '') || '').trim()
      if (!sourcePath) {
        let message: { fileName?: string; parsedContent?: string; fileExt?: string; createTime?: number; rawContent?: string } | undefined
        if (sessionId && localId != null && Number.isFinite(localId) && localId > 0) {
          const { chatService } = await import('../../chatService')
          const got = await chatService.getMessageByLocalId(sessionId, localId)
          if (got.success) message = got.message
          else if (!fileName) {
            return {
              error: got.error || '找不到这条消息',
              hint: '请先 search_messages 找到文件，再传入 sessionId 和 localId；或直接传 fileName / filePath。',
            }
          }
        }
        const resolvedName = String(fileName || (message ? fileNameFromMessage(message) : '')).trim()
        const located = await locateOrDownloadChatFile({
          sessionId,
          localId,
          message,
          fileName: resolvedName,
          fileExt: message?.fileExt,
          createTime: message?.createTime,
        })
        if (!located.filePath) {
          return { error: located.error || '本地没有这个文件', hint: located.hint }
        }
        sourcePath = located.filePath
        sourceName = located.fileName || resolvedName
      }
      if (!fs.existsSync(sourcePath)) return { error: '文件不存在' }
      const converted = await convertFileBuffer({
        buffer: fs.readFileSync(sourcePath),
        filename: sourceName || sourcePath,
        target: wanted,
      })
      if (!converted.ok || !converted.filePath) {
        return { error: converted.error || '转换失败' }
      }
      return {
        success: true,
        target: wanted,
        filePath: converted.filePath,
        fileName: converted.fileName,
        note: '已在本机转好。微信里用 send_wechat_file 把这个 filePath 发回去，回答里不要输出本地路径。',
      }
    } catch (error) {
      return { error: describeToolError(error, 'convert_chat_file 执行失败') }
    }
  },
})
