/**
 * 微信机器人会话档案：给「我 <-> 华记」起人能看的标题，并写每日运行日志。
 * 日志在 userData/logs/wechat-bot-YYYY-MM-DD.log，和普通技术日志分开。
 */
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getUserDataPath } from '../runtimePaths'

export type WechatBotRunLog = {
  from: string
  peerName?: string
  question: string
  tools?: string[]
  ok: boolean
  result: string
  durationMs: number
}

export async function resolveWechatPeerName(from: string): Promise<string> {
  const username = String(from || '').trim()
  if (!username) return ''
  try {
    const { chatService } = await import('../chatService')
    const contact = await chatService.getContact(username)
    const name = String(contact?.remark || contact?.nickName || contact?.alias || '').trim()
    if (name && name !== username) return name
  } catch {
    // 通讯录读不到时用微信 id，不影响主回复。
  }
  return username
}

export function wechatBotConversationTitle(peerName: string, fallbackText = ''): string {
  const name = String(peerName || '').trim()
  if (name) return ('微信 · ' + name).slice(0, 80)
  const snippet = String(fallbackText || '').replace(/\s+/g, ' ').trim().slice(0, 16)
  return snippet ? ('微信机器人 · ' + snippet) : '微信机器人'
}

export function writeWechatBotRunLog(entry: WechatBotRunLog): void {
  try {
    const dir = join(getUserDataPath(), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const file = join(dir, 'wechat-bot-' + day + '.log')
    const time = new Date().toLocaleString('zh-CN', { hour12: false })
    const question = String(entry.question || '').replace(/\s+/g, ' ').trim().slice(0, 200) || '(无文字)'
    const result = String(entry.result || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    const toolLine = entry.tools && entry.tools.length ? '- 工具: ' + entry.tools.join(', ') : ''
    const status = entry.ok ? '成功' : '失败'
    const detail = result || (entry.ok ? '已回复' : '未知原因')
    const seconds = String(Math.max(1, Math.round(entry.durationMs / 1000)))
    const lines = [
      '## ' + time,
      '- 来自: ' + (entry.peerName || entry.from),
      '- 问: ' + question,
      toolLine,
      '- 结果: ' + status + ' · ' + detail,
      '- 耗时: ' + seconds + 's',
      '',
    ].filter((line) => line !== '')
    appendFileSync(file, lines.join('\n') + '\n', 'utf8')
  } catch {
    // 写运行日志失败不影响回微信。
  }
}
