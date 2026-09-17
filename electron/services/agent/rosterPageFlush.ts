/**
 * 近一周/近一个月「所有私聊/群聊」翻页时，强制每一页先写成用户看得见的总结。
 * 否则模型会连着调几十次工具，上下文只剩最后一个人，界面就只剩「53. 夫人」。
 */
export const ROSTER_TOOL_NAMES = ['read_private_period', 'read_group_period'] as const

export type RosterPageSnapshot = {
  kind: 'private' | 'group'
  complete: boolean
  peopleIndex: number
  peopleTotal: number
  currentName: string
  remaining: number
  names: string[]
  nextCursor: unknown
}

type StepLike = {
  text?: unknown
  toolCalls?: Array<{ toolName?: unknown }>
  toolResults?: Array<{ toolName?: unknown; output?: unknown }>
}

export function isRosterToolName(name: string | undefined | null): boolean {
  return name === 'read_private_period' || name === 'read_group_period'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : 0
}

function packedNames(output: Record<string, unknown>): string[] {
  const packed = output.packedPeople
  if (!Array.isArray(packed)) return []
  const names: string[] = []
  for (const item of packed) {
    const rec = asRecord(item)
    const person = asRecord(rec?.person) || rec
    const name = readString(person?.displayName) || readString(person?.name)
    if (name) names.push(name)
  }
  return names
}

export function parseRosterToolOutput(toolName: string | undefined, output: unknown): RosterPageSnapshot | null {
  if (!isRosterToolName(toolName)) return null
  const rec = asRecord(output)
  if (!rec || rec.error) return null
  const person = asRecord(rec.person)
  const names = packedNames(rec)
  const currentName = names[names.length - 1] || readString(person?.displayName) || readString(rec.currentName)
  const peopleTotal = readNumber(person?.total) || readNumber(rec.peopleTotal)
  const peopleIndex = readNumber(person?.index) || readNumber(rec.peopleIndex)
  const remaining = readNumber(rec.peopleRemaining ?? rec.remaining)
  const kind: 'private' | 'group' = rec.kind === 'group' || toolName === 'read_group_period' ? 'group' : 'private'
  if (names.length === 0 && currentName) names.push(currentName)
  if (!currentName && peopleTotal <= 0 && rec.complete !== true) return null
  return {
    kind,
    complete: rec.complete === true || !rec.nextCursor,
    peopleIndex,
    peopleTotal,
    currentName,
    remaining,
    names,
    nextCursor: rec.nextCursor ?? null,
  }
}

export function latestRosterPageFromSteps(steps: StepLike[] | undefined): RosterPageSnapshot | null {
  if (!steps?.length) return null
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const results = steps[i]?.toolResults || []
    for (let j = results.length - 1; j >= 0; j -= 1) {
      const parsed = parseRosterToolOutput(readString(results[j]?.toolName), results[j]?.output)
      if (parsed) return parsed
    }
  }
  return null
}

export function isSubstantialRosterWrite(text: unknown): boolean {
  const raw = String(text || '').replace(/---wx-next---/g, '\n').trim()
  if (!raw) return false
  const compact = raw.replace(/\s+/g, '')
  if (/^(接着|捂一遍|写完|不绕了|我来看|开始整理|等我|还在查)/.test(compact) && compact.length < 80) return false
  if (/\d+\.\s*\S/.test(raw) && compact.length >= 16) return true
  return compact.length >= 80 || /今日待办|待办事项/.test(raw)
}

function lastStepHasRosterTool(step: StepLike | undefined): boolean {
  if (!step) return false
  const fromResults = (step.toolResults || []).some((item) => isRosterToolName(readString(item.toolName)))
  const fromCalls = (step.toolCalls || []).some((item) => isRosterToolName(readString(item.toolName)))
  return fromResults || fromCalls
}

export function shouldForceRosterPageWrite(steps: StepLike[] | undefined): RosterPageSnapshot | null {
  if (!steps?.length) return null
  const last = steps[steps.length - 1]
  if (!lastStepHasRosterTool(last)) return null
  if (isSubstantialRosterWrite(last.text)) return null
  return latestRosterPageFromSteps(steps)
}

export function shouldStopWechatAfterRosterWrite(outputMode: string | undefined, steps: StepLike[] | undefined): boolean {
  if (outputMode !== 'wechat' || !steps?.length) return false
  const last = steps[steps.length - 1]
  if (!last) return false
  if (!isSubstantialRosterWrite(last.text)) return false
  return latestRosterPageFromSteps(steps) != null
}

export function buildRosterPageWriteInstruction(page: RosterPageSnapshot): string {
  const unit = page.kind === 'group' ? '群' : '人'
  const names = page.names.length ? page.names.join('、') : page.currentName
  const indexHint = page.peopleIndex > 0 ? `${page.peopleIndex}` : '工具返回的 index'
  return [
    '刚才已经读完本页聊天原文。现在必须立刻写成用户看得见的总结，禁止再调用任何工具。',
    `- 本页${unit}：${names}。标题用「${indexHint}. 名字」，packedPeople 里每个人都要有自己的序号和一段。`,
    '- 写要点：约定、报价、货期、待办、文件名。语音/图片没有文字就写「有语音/有图，待核」，不要假装没看见。',
    '- 先输出独占一行 ---wx-next--- ，再写本页正文。',
    page.complete
      ? `- 这是最后一页（共 ${page.peopleTotal} 个${unit}）。不要说「已全部梳理完毕」来代替正文。写完本页即可。`
      : `- complete 为 false，还剩 ${page.remaining} 个${unit}。禁止说已经全部整理好了。写完本页即可，下一轮再带 nextCursor 继续。`,
    '- 本页会自动追加进本地 markdown，不必这一步调用 save_chat_summary。',
  ].join('\n')
}

export function buildRosterCloserInstruction(summaryPath?: string): string {
  const pathLine = summaryPath
    ? `完整总结已经追加在本地 ${summaryPath} ，告诉用户去华记记忆库看全文，不要把 md 发到微信。`
    : '完整总结已在本地 memory-bank/huaji-chat-summaries，不要把 md 发到微信。'
  return [
    '前面每一页正文已经发给用户了。现在只做收尾：',
    '1. 列出今日待办（今天该处理的事）。没有就写「今天没有从这些聊天里抽出待办」。',
    `2. ${pathLine}`,
    '禁止再说「N 人已全部梳理完毕」来代替前面那些人。禁止只写最后一个人。禁止再调用 read_private_period / read_group_period。',
  ].join('\n')
}
