/**
 * 华记本地搜索：人/群、已索引消息、文件名。不上传，不扫全库微信原库。
 */
import { chatService } from './chatService'
import { chatSearchIndexService } from './search/chatSearchIndexService'

const FILE_RE = /\.(?:xlsx|xls|pdf|docx|doc|dwg|png|jpg|jpeg|zip|csv)(?:\b|$)/i

export type HuajiSearchContactHit = {
  username: string
  displayName: string
  kind: 'person' | 'group' | 'official'
}

export type HuajiSearchMessageHit = {
  sessionId: string
  localId: number
  excerpt: string
  time: number
  fileName?: string
}

export type HuajiSearchResult = {
  query: string
  contacts: HuajiSearchContactHit[]
  messages: HuajiSearchMessageHit[]
  files: HuajiSearchMessageHit[]
}

function classify(username: string): HuajiSearchContactHit['kind'] {
  if (username.endsWith('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'official'
  return 'person'
}

function fileNameFromText(text: string): string {
  const match = String(text || '').match(/([^\s\\/]+\.(?:xlsx|xls|pdf|docx|doc|dwg|png|jpg|jpeg|zip|csv))/i)
  return match ? match[1] : ''
}

export async function searchHuaji(query: string): Promise<HuajiSearchResult> {
  const q = String(query || '').trim()
  if (!q) return { query: q, contacts: [], messages: [], files: [] }

  const contacts: HuajiSearchContactHit[] = []
  try {
    const sessions = await chatService.searchSessions(q)
    for (const session of sessions.sessions || []) {
      const username = String(session.username || '').trim()
      if (!username) continue
      contacts.push({
        username,
        displayName: String(session.displayName || username),
        kind: classify(username),
      })
    }
  } catch {
    // 会话搜索失败不影响消息
  }

  const indexed = chatSearchIndexService.searchIndexed(q, 50)
  const messages: HuajiSearchMessageHit[] = []
  const files: HuajiSearchMessageHit[] = []
  const seenFile = new Set<string>()
  for (const hit of indexed) {
    const localId = Number(hit.message?.localId || 0)
    if (!hit.sessionId || !localId) continue
    const text = [hit.excerpt, hit.message?.parsedContent, hit.message?.rawContent].map((item) => String(item || '')).join(' ')
    const item: HuajiSearchMessageHit = {
      sessionId: hit.sessionId,
      localId,
      excerpt: String(hit.excerpt || '').slice(0, 160),
      time: Number(hit.message?.createTime || 0),
    }
    const fileName = fileNameFromText(text)
    if (fileName || FILE_RE.test(text) || FILE_RE.test(q)) {
      const key = hit.sessionId + ':' + localId
      if (!seenFile.has(key)) {
        seenFile.add(key)
        files.push({ ...item, fileName: fileName || q })
      }
    }
    if (messages.length < 30) messages.push(item)
  }

  return {
    query: q,
    contacts: contacts.slice(0, 20),
    messages,
    files: files.slice(0, 20),
  }
}
