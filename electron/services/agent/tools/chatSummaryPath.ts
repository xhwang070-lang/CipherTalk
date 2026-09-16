/**
 * 聊天总结 markdown 只存本地 memory-bank，禁止当微信附件发出。
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { memoryDatabase } from '../../memory/memoryDatabase'

export const HUAJI_CHAT_SUMMARIES_DIR = 'huaji-chat-summaries'

export function isHuajiChatSummaryPath(filePath: string): boolean {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase()
  const marker = '/' + HUAJI_CHAT_SUMMARIES_DIR.toLowerCase()
  return normalized.includes(marker + '/') || normalized.endsWith(marker)
}

export const CHAT_SUMMARY_SEND_BLOCKED =
  '聊天总结只存本地，不发到微信。文件在 HuajiDB/memory-bank/huaji-chat-summaries，以后进 Obsidian。'

export type HuajiChatSummaryInfo = {
  fileName: string
  title: string
  sessionId?: string
  conversationId?: number
  created?: string
  path: string
}

export function listHuajiChatSummaries(limit = 30): HuajiChatSummaryInfo[] {
  const dir = join(memoryDatabase.getMemoryBankPath(), HUAJI_CHAT_SUMMARIES_DIR)
  if (!existsSync(dir)) return []
  const names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort().reverse().slice(0, Math.max(1, limit))
  return names.map((fileName) => {
    const filePath = join(dir, fileName)
    const raw = readFileSync(filePath, 'utf8').slice(0, 2000)
    const title = (raw.match(/^title:\s*"(.*)"/m) || raw.match(/^#\s+(.+)$/m) || [])[1] || fileName
    const sessionId = (raw.match(/^session:\s*"(.*)"/m) || [])[1] || ''
    const conversationId = Number((raw.match(/^conversationId:\s*(\d+)/m) || [])[1] || 0)
    const created = (raw.match(/^created:\s*"(.*)"/m) || [])[1] || ''
    return {
      fileName,
      title: String(title || fileName).trim(),
      sessionId: sessionId || undefined,
      conversationId: conversationId > 0 ? conversationId : undefined,
      created: created || undefined,
      path: filePath,
    }
  })
}
