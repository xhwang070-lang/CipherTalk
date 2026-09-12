import type { Message } from '../../../types/models'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function hm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function formatWechatTimeLabel(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const today = startOfDay(now)
  const thatDay = startOfDay(date)
  const dayDiff = Math.round((today.getTime() - thatDay.getTime()) / 86400000)
  const clock = hm(date)

  if (dayDiff === 0) return clock
  if (dayDiff === 1) return `昨天 ${clock}`
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

export function formatSessionTime(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const today = startOfDay(now)
  const thatDay = startOfDay(date)
  const dayDiff = Math.round((today.getTime() - thatDay.getTime()) / 86400000)

  if (dayDiff === 0) return hm(date)
  if (dayDiff === 1) return '昨天'
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

export function shouldShowDateDivider(msg: Message, prevMsg?: Message): boolean {
  if (!prevMsg) return true
  const date = new Date(msg.createTime * 1000).toDateString()
  const prevDate = new Date(prevMsg.createTime * 1000).toDateString()
  return date !== prevDate
}

export function formatDateDivider(timestamp: number): string {
  return formatWechatTimeLabel(timestamp)
}

export function formatBatchDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return `${y}年${m}月${d}日`
}
