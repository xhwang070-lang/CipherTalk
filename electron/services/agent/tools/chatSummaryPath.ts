/**
 * 聊天总结 markdown 只存本地 memory-bank，禁止当微信附件发出。
 */
export const HUAJI_CHAT_SUMMARIES_DIR = 'huaji-chat-summaries'

export function isHuajiChatSummaryPath(filePath: string): boolean {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase()
  const marker = '/' + HUAJI_CHAT_SUMMARIES_DIR.toLowerCase()
  return normalized.includes(marker + '/') || normalized.endsWith(marker)
}

export const CHAT_SUMMARY_SEND_BLOCKED =
  '聊天总结只存本地，不发到微信。文件在 HuajiDB/memory-bank/huaji-chat-summaries，以后进 Obsidian。'
