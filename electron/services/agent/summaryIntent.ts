/**
 * 从用户原话推断总结的时间窗和范围。用户这句话压过工具默认值。
 */
export type ChatSummaryScope = 'private' | 'group' | 'all' | 'named'

export type ChatSummaryIntent = {
  kind: 'summary'
  period: string
  scope: ChatSummaryScope
  includeFolded: boolean
}

export function isContinueCommand(text: string): boolean {
  return /^(?:续|接着写|继续)$/.test(String(text || '').replace(/\s+/g, ''))
}

export function parsePeriodPhrase(text: string): string | null {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact) return null
  if (/(近3个月|近三个月|最近三个月)/.test(compact)) return '近3个月'
  if (/(近一个月|最近一个月|近一月|最近一月|过去一个月)/.test(compact)) return '近一个月'
  if (/(本月|这个月)/.test(compact)) return '本月'
  if (/(近一周|最近一周|这一周|这周|近7天|近七天|最近七天)/.test(compact)) return '近一周'
  if (/(近3天|近三天|最近三天|这三天)/.test(compact)) return '近3天'
  if (/前天/.test(compact)) return '前天'
  if (/(昨天|昨日)/.test(compact)) return '昨天'
  if (/(今天|今日)/.test(compact)) return '今天'
  return null
}

export function inferChatSummaryIntent(text: string): ChatSummaryIntent | null {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact || isContinueCommand(compact)) return null
  if (/(多少条|谁最活跃|排行|排名|统计一下|一共多少)/.test(compact)) return null
  if (compact.includes('待办') && !/(总结|梳理|复盘|回顾)/.test(compact)) return null

  const asksSummary = /(总结|梳理|复盘|回顾|聊了什么|在聊什么|聊天记录)/.test(compact)
    || /今天的事情/.test(compact)
  if (!asksSummary) return null

  const period = parsePeriodPhrase(compact) || '近一周'
  const includeFolded = /(不包括折叠|排除折叠|不要折叠)/.test(compact)
    ? false
    : /(包括折叠|含折叠|折叠也要|折叠的也要|折叠也算)/.test(compact)

  let scope: ChatSummaryScope = 'private'
  if (/(跟我|和我|我和|我跟)/.test(compact) && !/(全部|所有)/.test(compact)) scope = 'named'
  else if (/(全部聊天|所有聊天|全部的聊天|所有的聊天)/.test(compact)) scope = 'all'
  else if (compact.includes('群聊') && !/(私聊|私信)/.test(compact)) scope = 'group'
  else if (/(私聊|私信)/.test(compact) && !compact.includes('群聊')) scope = 'private'
  else if (/今天的事情/.test(compact) || /聊天记录/.test(compact)) scope = 'all'

  return { kind: 'summary', period, scope, includeFolded }
}

export function summaryScopeLabel(scope: ChatSummaryScope): string {
  if (scope === 'group') return '群聊'
  if (scope === 'all') return '全部聊天（私聊+群聊）'
  if (scope === 'named') return '点名的那场聊天'
  return '私聊'
}

export function buildSummarySteer(intent: ChatSummaryIntent): string {
  const folded = intent.includeFolded ? '包括折叠的聊天' : '排除折叠的聊天'
  const periodArg = `{period:'${intent.period}'${intent.includeFolded ? ', includeFolded:true' : ''}}`
  if (intent.scope === 'named') {
    return `按用户原话总结「${intent.period}」点名的那场聊天，${folded}。先 list_contacts 拿 sessionId，再 read_period({sessionId, period:'${intent.period}'})。禁止扩成近一周。不要先查待办本。`
  }
  if (intent.scope === 'group') {
    return `按用户原话总结「${intent.period}」的所有群聊，${folded}。立刻 read_group_period(${periodArg})。禁止改成近一周。不要问群名。不要先查待办本。`
  }
  if (intent.scope === 'all') {
    return `按用户原话总结「${intent.period}」的全部聊天（私聊+群聊），${folded}。先 read_private_period(${periodArg})，这一侧 complete 后再 read_group_period(${periodArg})。禁止改成近一周。不要问人名。不要先查待办本。`
  }
  return `按用户原话总结「${intent.period}」的所有私聊，${folded}。立刻 read_private_period(${periodArg})。禁止改成近一周。不要问人名。不要先查待办本。`
}

export function forceSummaryReadText(intent: ChatSummaryIntent): string {
  const media = '语音用 transcribe_voice_message，图片用 inspect_media_image。人名、金额必须对原文，对不上写待核。'
  return `上一轮没有按用户原话读聊天原文，作废。${buildSummarySteer(intent)}有 nextCursor 就继续调，直到 complete=true。${media}`
}

export function summaryRetryHint(intent: ChatSummaryIntent): string {
  return `这次还没读到${summaryScopeLabel(intent.scope)}原文。请再发一遍：把${intent.period}的${summaryScopeLabel(intent.scope)}总结一下。`
}
