/**
 * save_chat_summary —— 把已经按天写完的聊天总结存成本地 markdown。
 * 一周以上的完整总结必须存；微信里再 send_wechat_file 发出去。
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tool } from 'ai'
import { z } from 'zod'
import { memoryDatabase } from '../../memory/memoryDatabase'
import { describeToolError } from './shared'

function safePart(value: string): string {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'summary'
}

export const saveChatSummary = tool({
  description:
    '把已经写完的聊天总结存成本地 markdown 文件。近一周或近一个月的完整总结必须调用。' +
    'content 必须是按天写全的正文，不要只存提纲。返回 path，微信入口再用 send_wechat_file 把这个文件发给当前会话。',
  inputSchema: z.object({
    title: z.string().min(1).describe('标题，如 张俊博 2026-08-16 至 2026-09-15'),
    content: z.string().min(20).describe('按天写全的总结正文'),
    sessionId: z.string().optional().describe('会话 username'),
    startDate: z.string().optional().describe('覆盖起始 YYYY-MM-DD'),
    endDate: z.string().optional().describe('覆盖结束 YYYY-MM-DD'),
  }),
  execute: async ({ title, content, sessionId, startDate, endDate }) => {
    try {
      const dir = join(memoryDatabase.getMemoryBankPath(), 'huaji-chat-summaries')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const stamp = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      const when = `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}`
      const range = [startDate, endDate].filter(Boolean).join('_')
      const fileName = `${when}-${safePart(range || 'period')}-${safePart(title)}.md`
      const filePath = join(dir, fileName)
      const header = [
        `# ${title}`,
        '',
        sessionId ? `- 会话：${sessionId}` : '',
        startDate || endDate ? `- 覆盖：${startDate || ''} ~ ${endDate || ''}` : '',
        `- 生成：${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())} ${p(stamp.getHours())}:${p(stamp.getMinutes())}`,
        '',
      ].filter(Boolean).join('\n')
      writeFileSync(filePath, `${header}\n${content.trim()}\n`, 'utf8')
      return {
        success: true,
        path: filePath,
        fileName,
        bytes: Buffer.byteLength(content, 'utf8'),
        hint: '微信入口请再调用 send_wechat_file({ filePath }) 把这份总结发给当前会话。',
      }
    } catch (error) {
      return { error: describeToolError(error, 'save_chat_summary 执行失败') }
    }
  },
})
