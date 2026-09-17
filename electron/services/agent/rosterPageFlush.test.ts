import {
  parseRosterToolOutput,
  shouldForceRosterPageWrite,
  shouldStopWechatAfterRosterWrite,
  isSubstantialRosterWrite,
  buildRosterPageWriteInstruction,
  stripRosterInternals,
} from './rosterPageFlush.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const packedOutput = {
  kind: 'private',
  complete: false,
  person: { displayName: '李四', index: 8, total: 53 },
  packedPeople: [
    { person: { displayName: '张三', index: 1 } },
    { person: { displayName: '李四', index: 2 } },
  ],
  peopleRemaining: 45,
  nextCursor: { cursorUsername: 'wxid_next' },
}

const packed = parseRosterToolOutput('read_private_period', packedOutput)
assert(packed && packed.names.join(',') === '张三,李四', 'packed names')
assert(packed && packed.remaining === 45, 'remaining')

const lastPerson = parseRosterToolOutput('read_private_period', {
  kind: 'private',
  complete: true,
  person: { displayName: '夫人', index: 53, total: 53 },
  peopleRemaining: 0,
  nextCursor: null,
})
assert(lastPerson && lastPerson.complete && lastPerson.currentName === '夫人', 'last person')

const toolStep = {
  text: '',
  toolCalls: [{ toolName: 'read_private_period' }],
  toolResults: [{ toolName: 'read_private_period', output: packedOutput }],
}
assert(shouldForceRosterPageWrite([toolStep])?.names.includes('张三') === true, 'force write after tool-only page')
assert(!shouldForceRosterPageWrite([{ ...toolStep, text: '1. 张三\n今天要报价，明天发货，合同号待核。' }]), 'do not force if page already written')

const writeStep = { text: '1. 张三\n今天要报价，明天发货，合同号待核。', toolCalls: [], toolResults: [] }
assert(shouldStopWechatAfterRosterWrite('wechat', [toolStep, writeStep]) === true, 'wechat stops after page write')
assert(shouldStopWechatAfterRosterWrite('chat', [toolStep, writeStep]) === false, 'in-app keeps going')
assert(!isSubstantialRosterWrite('我接着写'), 'preamble is not a page')
assert(buildRosterPageWriteInstruction(packed!).includes('张三'), 'instruction names')

console.log('rosterPageFlush ok')

const dumped = '### 3. 打字单\n样图审核完。\n---\n当前进度：第 3/73 群已全部翻完，游标 `{"cursorUsername":"53257063169@chatroom"}`'
assert(!stripRosterInternals(dumped).includes('cursorUsername'), 'strip cursor')
assert(!stripRosterInternals(dumped).includes('当前进度'), 'strip progress')
assert(stripRosterInternals(dumped).includes('打字单'), 'keep body')
console.log('stripRosterInternals ok')
