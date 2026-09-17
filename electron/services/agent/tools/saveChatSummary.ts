/**
 * save_chat_summary —— 把已经按天写完的聊天总结存成本地 markdown。
 * 一周以上的完整总结必须存；只落本地 memory-bank，不发到微信。以后进 Obsidian。
 * 近一周全私聊/群聊翻页时，引擎会按页 append，避免只留下最后一个人。
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tool } from 'ai'
import { z } from 'zod'
import { memoryDatabase } from '../../memory/memoryDatabase'
import { describeToolError } from './shared'
import { HUAJI_CHAT_SUMMARIES_DIR } from './chatSummaryPath'
import { stripRosterInternals } from '../rosterPageFlush'

function safePart(value: string): string {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'summary'
}

function yamlScalar(value: string): string {
  return String(value || '').replace(/"/g, '\\"').trim()
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function stampParts(stamp = new Date()) {
  const when = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
  const created = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`
  return { when, created }
}

function summariesDir(): string {
  const dir = join(memoryDatabase.getMemoryBankPath(), HUAJI_CHAT_SUMMARIES_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

type ActiveSummary = {
  path: string
  fileName: string
  title: string
}

let activeSummary: ActiveSummary | null = null

export function resetChatSummarySession(): void {
  activeSummary = null
}

export function getActiveChatSummaryPath(): string {
  return activeSummary?.path || ''
}

function writeNewSummaryFile(title: string, content: string, sessionId?: string, startDate?: string, endDate?: string): ActiveSummary {
  const dir = summariesDir()
  const { when, created } = stampParts()
  const range = [startDate, endDate].filter(Boolean).join('_')
  const fileName = `${when}-${safePart(range || 'period')}-${safePart(title)}.md`
  const filePath = join(dir, fileName)
  const frontmatter = [
    '---',
    `title: "${yamlScalar(title)}"`,
    'type: chat-summary',
    'source: huaji',
    sessionId ? `session: "${yamlScalar(sessionId)}"` : '',
    startDate ? `coverage_start: ${startDate}` : '',
    endDate ? `coverage_end: ${endDate}` : '',
    `created: "${created}"`,
    'tags:',
    '  - huaji',
    '  - chat-summary',
    '---',
    '',
  ].filter((line, index, lines) => line !== '' || index === lines.length - 1).join('\n')
  const header = [
    `# ${title}`,
    '',
    sessionId ? `- 会话：${sessionId}` : '',
    startDate || endDate ? `- 覆盖：${startDate || ''} ~ ${endDate || ''}` : '',
    `- 生成：${created}`,
    '',
  ].filter(Boolean).join('\n')
  writeFileSync(filePath, `${frontmatter}${header}\n${content.trim()}\n`, 'utf8')
  activeSummary = { path: filePath, fileName, title }
  return activeSummary
}

export function appendChatSummaryPage(input: {
  content: string
  title?: string
  sessionId?: string
  startDate?: string
  endDate?: string
  pageLabel?: string
}): { success: true; path: string; fileName: string; appended: boolean; bytes: number } | { error: string } {
  const content = stripRosterInternals(input.content)
  if (content.length < 20) return { error: '本页总结太短，未写入' }
  const title = String(input.title || activeSummary?.title || '近一周聊天总结').trim() || '近一周聊天总结'
  try {
    if (!activeSummary || !existsSync(activeSummary.path)) {
      const created = writeNewSummaryFile(title, content, input.sessionId, input.startDate, input.endDate)
      return {
        success: true,
        path: created.path,
        fileName: created.fileName,
        appended: false,
        bytes: Buffer.byteLength(content, 'utf8'),
      }
    }
    const label = String(input.pageLabel || '').trim()
    const chunk = label ? `\n\n## ${label}\n\n${content}\n` : `\n\n${content}\n`
    appendFileSync(activeSummary.path, chunk, 'utf8')
    return {
      success: true,
      path: activeSummary.path,
      fileName: activeSummary.fileName,
      appended: true,
      bytes: Buffer.byteLength(content, 'utf8'),
    }
  } catch (error) {
    return { error: describeToolError(error, 'save_chat_summary 追加失败') }
  }
}

export const saveChatSummary = tool({
  description:
    '把已经写完的聊天总结存成本地 markdown 文件。近一周或近一个月的完整总结必须调用。' +
    '全私聊/群聊翻页时引擎会自动按页追加；你只需在全部写完后补今日待办，mode 用 append。' +
    'content 必须是按天写全的正文，不要只存提纲。文件只存本地，禁止再 send_wechat_file / send_wechat_media。' +
    '微信里用文字回复要点即可。',
  inputSchema: z.object({
    title: z.string().min(1).describe('标题，如 近一周私聊总结 2026-09-11 至 2026-09-17'),
    content: z.string().min(20).describe('按天写全的总结正文，或本页/今日待办要追加的段落'),
    sessionId: z.string().optional().describe('会话 username'),
    startDate: z.string().optional().describe('覆盖起始 YYYY-MM-DD'),
    endDate: z.string().optional().describe('覆盖结束 YYYY-MM-DD'),
    mode: z.enum(['replace', 'append']).optional().describe('append=追加到本次正在写的文件；默认 replace 新建'),
  }),
  execute: async ({ title, content, sessionId, startDate, endDate, mode }) => {
    try {
      if (mode === 'append' || (activeSummary && mode !== 'replace')) {
        const saved = appendChatSummaryPage({ title, content, sessionId, startDate, endDate })
        if ('error' in saved) return saved
        return {
          ...saved,
          hint: '已追加到本地，不要调用 send_wechat_file / send_wechat_media。微信里用文字回复要点即可。',
        }
      }
      const created = writeNewSummaryFile(title, content, sessionId, startDate, endDate)
      return {
        success: true,
        path: created.path,
        fileName: created.fileName,
        bytes: Buffer.byteLength(content, 'utf8'),
        hint: '已存本地，不要调用 send_wechat_file / send_wechat_media。微信里用文字回复要点即可。以后这份 md 会进 Obsidian。',
      }
    } catch (error) {
      return { error: describeToolError(error, 'save_chat_summary 执行失败') }
    }
  },
})
