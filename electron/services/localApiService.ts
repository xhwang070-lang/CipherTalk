import * as http from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import type { Socket } from 'net'
import { chatService } from './chatService'

const HOST = '127.0.0.1' as const

export type LocalApiStatus = {
  running: boolean
  host: typeof HOST
  port: number
  startedAt: number
  tokenConfigured: boolean
  lastError: string
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

function readToken(req: http.IncomingMessage): string {
  const header = String(req.headers.authorization || '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const key = req.headers['x-api-key']
  if (typeof key === 'string') return key.trim()
  if (Array.isArray(key) && key[0]) return String(key[0]).trim()
  return ''
}

export function generateLocalApiToken(): string {
  return randomBytes(24).toString('hex')
}

class LocalApiService {
  private server: http.Server | null = null
  private readonly connections = new Set<Socket>()
  private startedAt = 0
  private lastError = ''
  private port = 5034
  private token = ''

  applySettings(port: number, token: string): void {
    this.port = Math.max(1024, Math.min(65535, Math.floor(port) || 5034))
    this.token = String(token || '').trim()
  }

  isRunning(): boolean {
    return Boolean(this.server)
  }

  getStatus(): LocalApiStatus {
    return {
      running: this.isRunning(),
      host: HOST,
      port: this.port,
      startedAt: this.startedAt,
      tokenConfigured: Boolean(this.token),
      lastError: this.lastError
    }
  }

  async start(): Promise<{ success: boolean; error?: string; status?: LocalApiStatus }> {
    if (this.server) return { success: true, status: this.getStatus() }
    if (!this.token) return { success: false, error: '未配置 API 密钥' }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res)
      })

      server.on('connection', (socket) => {
        this.connections.add(socket)
        socket.on('close', () => this.connections.delete(socket))
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        this.lastError = err.message
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `端口 ${this.port} 已被占用` })
          return
        }
        resolve({ success: false, error: err.message })
      })

      server.listen(this.port, HOST, () => {
        this.server = server
        this.startedAt = Date.now()
        this.lastError = ''
        resolve({ success: true, status: this.getStatus() })
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const current = this.server
    this.server = null
    const sockets = Array.from(this.connections)
    this.connections.clear()
    sockets.forEach((socket) => {
      try { socket.destroy() } catch { /* ignore */ }
    })
    await new Promise<void>((resolve) => current.close(() => resolve()))
    this.startedAt = 0
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method_not_allowed' })
        return
      }
      if (!this.token || !safeEqual(readToken(req), this.token)) {
        json(res, 401, { error: 'unauthorized' })
        return
      }

      const url = new URL(req.url || '/', `http://${HOST}`)
      const path = url.pathname.replace(/\/+$/, '') || '/'

      if (path === '/health' || path === '/v1/health') {
        json(res, 200, { ok: true, app: 'huaji', host: HOST, port: this.port })
        return
      }

      if (path === '/v1/me') {
        const me = await chatService.getMyUserInfo()
        json(res, me.success ? 200 : 503, me)
        return
      }

      if (path === '/v1/sessions') {
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0)
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50) || 50))
        const result = await chatService.getSessions(offset, limit)
        json(res, result.success ? 200 : 503, result)
        return
      }

      const messagesMatch = path.match(/^\/v1\/sessions\/([^/]+)\/messages$/)
      if (messagesMatch) {
        const sessionId = decodeURIComponent(messagesMatch[1] || '').trim()
        if (!sessionId || sessionId.length > 200) {
          json(res, 400, { error: 'invalid_session' })
          return
        }
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0)
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50) || 50))
        const result = await chatService.getMessages(sessionId, offset, limit)
        if (!result.success) {
          json(res, 503, result)
          return
        }
        json(res, 200, {
          success: true,
          hasMore: result.hasMore,
          messages: (result.messages || []).map((msg) => ({
            localId: msg.localId,
            createTime: msg.createTime,
            localType: msg.localType,
            isSend: msg.isSend,
            senderUsername: msg.senderUsername,
            parsedContent: msg.parsedContent
          }))
        })
        return
      }

      json(res, 404, { error: 'not_found' })
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
  }
}

export const localApiService = new LocalApiService()
