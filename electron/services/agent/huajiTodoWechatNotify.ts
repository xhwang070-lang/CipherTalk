/**
 * 华记待办 -> 华博服务号。
 * 本机不拿 AppSecret，只把摘要 POST 到画册后端，由服务号模板发给值班微信。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getUserDataPath } from '../runtimePaths'
import { listHuajiTodos, peekMorningServicePush, consumeMorningServicePush } from './huajiTodos'
import { localDateKey } from './huajiWorkLog'

export type TodoWechatNotifyConfig = {
  enabled: boolean
  endpoint: string
  token: string
}

const FILE = 'todo-wechat-notify.json'
const DEFAULT_ENDPOINT = 'https://catalog.cnhuabo.cn/api/huaji/todo-notify'

function configPath(): string {
  return join(getUserDataPath(), FILE)
}

function clip(value: string, max: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

export function getTodoWechatNotifyConfig(): TodoWechatNotifyConfig {
  const fallback: TodoWechatNotifyConfig = {
    enabled: false,
    endpoint: DEFAULT_ENDPOINT,
    token: '',
  }
  try {
    if (!existsSync(configPath())) return fallback
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<TodoWechatNotifyConfig>
    return {
      enabled: parsed.enabled === true,
      endpoint: String(parsed.endpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT,
      token: String(parsed.token || '').trim(),
    }
  } catch {
    return fallback
  }
}

export function saveTodoWechatNotifyConfig(input: Partial<TodoWechatNotifyConfig>): TodoWechatNotifyConfig {
  const current = getTodoWechatNotifyConfig()
  const next: TodoWechatNotifyConfig = {
    enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
    endpoint: input.endpoint === undefined ? current.endpoint : (String(input.endpoint || '').trim() || DEFAULT_ENDPOINT),
    token: input.token === undefined ? current.token : String(input.token || '').trim(),
  }
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function publicTodoWechatNotifyConfig(): { enabled: boolean; endpoint: string; hasToken: boolean } {
  const cfg = getTodoWechatNotifyConfig()
  return { enabled: cfg.enabled, endpoint: cfg.endpoint, hasToken: Boolean(cfg.token) }
}

export function buildTodoNotifyPayload(when: 'today' | 'tomorrow' = 'today', test = false): { title: string; detail: string; count: number } {
  const items = listHuajiTodos(when).filter((item) => !item.done)
  const label = when === 'tomorrow' ? '明日待办' : '今日待办'
  const title = test && items.length === 0 ? '华记待办测试' : `${label} ${items.length}条`
  const detail = items.length
    ? items.slice(0, 2).map((item) => (item.person ? item.person + '：' : '') + item.title).join('；')
    : (test ? '测试消息，打开华记看完整待办' : '暂无')
  return { title: clip(title, 20), detail: clip(detail, 20), count: items.length }
}

export async function sendTodoWechatNotify(options?: { test?: boolean; when?: 'today' | 'tomorrow' }): Promise<{ success: boolean; skipped?: boolean; sent?: number; error?: string }> {
  const cfg = getTodoWechatNotifyConfig()
  if (!options?.test && !cfg.enabled) return { success: false, skipped: true, error: '还没打开服务号提醒' }
  if (!cfg.token) return { success: false, error: '还没填通知密钥' }
  const payload = buildTodoNotifyPayload(options?.when || 'today', options?.test === true)
  if (!options?.test && payload.count === 0) return { success: true, skipped: true, error: '今日待办是空的' }
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Huaji-Token': cfg.token,
    },
    body: JSON.stringify({
      title: payload.title,
      detail: payload.detail,
      count: payload.count,
      test: options?.test === true,
    }),
  })
  const body = await res.text()
  let data: { success?: boolean; skipped?: boolean; sent?: number; message?: string } = {}
  try { data = JSON.parse(body) } catch { data = {} }
  if (!res.ok || data.success === false) {
    return { success: false, error: data.message || body.slice(0, 180) || ('HTTP ' + res.status) }
  }
  return { success: true, skipped: data.skipped, sent: data.sent || 0 }
}

export async function pushMorningTodosToServiceAccountIfDue(now = new Date()): Promise<{ pushed: boolean; reason: string }> {
  if (now.getHours() < 8) return { pushed: false, reason: '未到早上' }
  const cfg = getTodoWechatNotifyConfig()
  if (!cfg.enabled) return { pushed: false, reason: '未开启' }
  const today = localDateKey(now.getTime())
  if (peekMorningServicePush(today)) return { pushed: false, reason: '今天已经推过' }
  const items = listHuajiTodos('today').filter((item) => !item.done)
  if (items.length === 0) return { pushed: false, reason: '今日待办是空的' }
  const result = await sendTodoWechatNotify({ when: 'today' })
  if (!result.success) return { pushed: false, reason: result.error || '发送失败' }
  if (result.skipped) return { pushed: false, reason: result.error || '跳过' }
  consumeMorningServicePush(today)
  return { pushed: true, reason: '已发到华博服务号' }
}
