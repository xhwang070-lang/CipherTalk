/**
 * 给 AI SDK 调用注入代理 —— Node 全局 fetch(undici) 不认 https-proxy-agent 的 http.Agent，
 * 需用 undici 的 ProxyAgent 作 dispatcher。用 undici 自带的 fetch + ProxyAgent（同包，兼容）。
 *
 * 代理 URL 的跨进程流转：主进程靠 Electron session 探测系统代理（子进程无此 API），
 * 探测结果写入 config.aiResolvedProxyUrl；主/子进程都从 config 读（ConfigService 两边可用）。
 * 适用范围：http/https 代理。SOCKS 暂不支持（undici ProxyAgent 不支持），会回退直连。
 */
import { Agent, fetch as undiciFetch, ProxyAgent } from 'undici'
import { ConfigService } from '../config'

const CONFIG_KEY = 'aiResolvedProxyUrl'

/** 读取已持久化的代理 URL（任意进程可用）。 */
export function getResolvedProxyUrl(): string | null {
  const cs = new ConfigService()
  try {
    const v = String(cs.get(CONFIG_KEY) || '').trim()
    return v || null
  } catch {
    return null
  } finally {
    cs.close()
  }
}

/**
 * 主进程：探测系统代理并持久化到 config，供子进程读取。
 * 子进程无 session API，proxyService 会返回 null（即写空 = 直连），故此函数实际只在主进程有意义。
 */
export async function refreshResolvedProxyUrl(): Promise<string | null> {
  try {
    const { proxyService } = await import('./proxyService')
    const url = await proxyService.getSystemProxy()
    const cs = new ConfigService()
    try {
      cs.set(CONFIG_KEY, url || '')
    } finally {
      cs.close()
    }
    return url || null
  } catch {
    return null
  }
}

/**
 * 把代理 URL 变成可注入 AI SDK provider 的 fetch；无代理 / SOCKS 返回 undefined → 走默认直连。
 */
export function createProxyFetch(proxyUrl?: string | null): typeof globalThis.fetch | undefined {
  if (!proxyUrl) return undefined
  if (proxyUrl.startsWith('socks')) {
    console.warn('[proxyFetch] 暂不支持 SOCKS 代理（undici ProxyAgent 仅 http/https），回退直连；建议改用 HTTP 代理端口。')
    return undefined
  }
  let dispatcher: ProxyAgent
  try {
    dispatcher = new ProxyAgent(proxyUrl)
  } catch (e) {
    console.error('[proxyFetch] 创建 ProxyAgent 失败，回退直连：', e)
    return undefined
  }
  const proxied = (input: any, init?: any) => undiciFetch(input, { ...init, dispatcher })
  return proxied as unknown as typeof globalThis.fetch
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 强制直连，绕过环境变量里的 HTTP_PROXY（国内中转站走代理常被 Cloudflare 拦）。 */
export function createDirectFetch(): typeof globalThis.fetch {
  const dispatcher = new Agent()
  const direct = (input: any, init?: any) => {
    const headers = {
      'user-agent': BROWSER_UA,
      ...(init?.headers || {})
    }
    return undiciFetch(input, { ...init, headers, dispatcher })
  }
  return direct as unknown as typeof globalThis.fetch
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function describeAiFetchTarget(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host + parsed.pathname
  } catch {
    return 'invalid-url'
  }
}

export function requestUrlOf(input: any): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  if (input && typeof input.url === 'string') return input.url
  return String(input || '')
}

/** openai/anthropic 等境外站可走系统代理；自定义中转默认直连。 */
export function isLoopbackAiHost(url?: string | null): boolean {
  const host = hostnameOf(String(url || ''))
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost')
}

export function isPrivateLanAiHost(url?: string | null): boolean {
  const host = hostnameOf(String(url || ''))
  if (isLoopbackAiHost(url)) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const parts = ipv4.slice(1).map((item) => Number(item))
  if (parts.some((part) => part > 255)) return false
  const [a, b] = parts
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31
}

export function shouldProxyAiRequest(baseURL?: string | null): boolean {
  const host = hostnameOf(String(baseURL || ''))
  if (!host || isPrivateLanAiHost(baseURL)) return false
  return /(^|\.)openai\.com$|(^|\.)anthropic\.com$|(^|\.)googleapis\.com$|(^|\.)google\.com$|(^|\.)openrouter\.ai$|(^|\.)x\.ai$/i.test(host)
}

function createDefaultChromiumFetch(): typeof globalThis.fetch | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { net?: { fetch?: typeof globalThis.fetch } }
    const netFetch = electron.net?.fetch
    if (!netFetch) return undefined
    const wrapped = (input: any, init?: any) => {
      const headers = {
        'user-agent': BROWSER_UA,
        ...(init?.headers || {})
      }
      return netFetch(input, { ...init, headers })
    }
    return wrapped as unknown as typeof globalThis.fetch
  } catch {
    return undefined
  }
}

let directSessionPromise: Promise<any> | null = null

async function getDirectChromiumSession(): Promise<any | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { session?: { fromPartition: (name: string) => any } }
    const fromPartition = electron.session?.fromPartition
    if (!fromPartition) return null
    if (!directSessionPromise) {
      directSessionPromise = (async () => {
        const ses = fromPartition('persist:ciphertalk-ai-direct')
        await ses.setProxy({ mode: 'direct' })
        console.log('[proxyFetch] 直连 Chromium session 已就绪')
        return ses
      })()
    }
    return await directSessionPromise
  } catch (e) {
    console.warn('[proxyFetch] 无法创建直连 Chromium session:', e)
    directSessionPromise = null
    return null
  }
}

/** 主进程直连：独立 session + mode=direct，避免系统代理 10808 把中转站打到 Cloudflare。 */
export async function fetchAiDirect(input: any, init?: any): Promise<Response> {
  const headers = {
    'user-agent': BROWSER_UA,
    ...(init?.headers || {}),
  }
  const ses = await getDirectChromiumSession()
  if (ses?.fetch) {
    return ses.fetch(requestUrlOf(input), { ...init, headers })
  }
  return createDirectFetch()(input, { ...init, headers }) as Promise<Response>
}

function createDirectChromiumFetch(): typeof globalThis.fetch | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { session?: { fromPartition?: Function } }
    if (!electron.session?.fromPartition) return undefined
    return ((input: any, init?: any) => fetchAiDirect(input, init)) as typeof globalThis.fetch
  } catch {
    return undefined
  }
}

export function resolveAiFetch(baseURL?: string | null): typeof globalThis.fetch | undefined {
  const direct = createDirectFetch()
  if (isPrivateLanAiHost(baseURL)) return direct
  const proxied = createProxyFetch(getResolvedProxyUrl())
  if (proxied) {
    return ((input: any, init?: any) => {
      const url = requestUrlOf(input)
      if (isPrivateLanAiHost(url) || isPrivateLanAiHost(baseURL)) return direct(input, init)
      return proxied(input, init)
    }) as typeof globalThis.fetch
  }
  if (shouldProxyAiRequest(baseURL)) {
    return createDefaultChromiumFetch() || direct
  }
  const parentFetch = createParentAiFetch()
  if (parentFetch) return parentFetch
  return createDirectChromiumFetch() || direct
}

export function isCloudflareOrHtmlBody(body: string): boolean {
  const text = String(body || '')
  const lower = text.slice(0, 2000).toLowerCase()
  return lower.includes('<!doctype html') || lower.includes('<html') || lower.includes('cloudflare') || lower.includes('attention required')
}

type ParentAiFetchPending = {
  meta: (status: number, headers: Record<string, string>) => void
  chunk: (data: Uint8Array) => void
  end: () => void
  error: (err: Error) => void
}

let parentAiFetchSeq = 1
let parentAiFetchListening = false
const parentAiFetchPending = new Map<number, ParentAiFetchPending>()

function getParentPort(): { on: Function; postMessage: Function } | undefined {
  return (process as NodeJS.Process & { parentPort?: { on: Function; postMessage: Function } }).parentPort
}

function ensureParentAiFetchListener(): void {
  if (parentAiFetchListening) return
  const port = getParentPort()
  if (!port) return
  parentAiFetchListening = true
  port.on('message', (event: { data?: any }) => {
    const msg = event?.data
    if (!msg?.type || !String(msg.type).startsWith('aiFetch:')) return
    const payload = msg.payload || {}
    const pending = parentAiFetchPending.get(Number(payload.reqId))
    if (!pending) return
    if (msg.type === 'aiFetch:meta') pending.meta(Number(payload.status) || 0, payload.headers || {})
    else if (msg.type === 'aiFetch:chunk') pending.chunk(Buffer.from(String(payload.chunk || ''), 'base64'))
    else if (msg.type === 'aiFetch:end') {
      pending.end()
      parentAiFetchPending.delete(Number(payload.reqId))
    } else if (msg.type === 'aiFetch:error') {
      pending.error(new Error(String(payload.error || 'ai fetch failed')))
      parentAiFetchPending.delete(Number(payload.reqId))
    }
  })
}

async function readFetchBody(body: any): Promise<string | undefined> {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString('utf8')
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Buffer[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  return undefined
}

function serializeFetchHeaders(headers: any): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (typeof headers.forEach === 'function') {
    headers.forEach((value: string, key: string) => { out[key] = value })
    return out
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1])
    }
    return out
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    out[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

function createParentAiFetch(): typeof globalThis.fetch | undefined {
  if (process.env.CT_AGENT_AI_FETCH_PROXY !== '1') return undefined
  const port = getParentPort()
  if (!port) return undefined
  ensureParentAiFetchListener()
  return (async (input: any, init?: any) => {
    const reqId = parentAiFetchSeq++
    const body = await readFetchBody(init?.body)
    const headers = serializeFetchHeaders(init?.headers)
    return await new Promise<Response>((resolve, reject) => {
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
      const readable = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller }
      })
      parentAiFetchPending.set(reqId, {
        meta: (status, responseHeaders) => {
          resolve(new Response(readable, { status, headers: responseHeaders }))
        },
        chunk: (data) => { streamController?.enqueue(data) },
        end: () => { try { streamController?.close() } catch { /* ignore */ } },
        error: (err) => {
          try { streamController?.error(err) } catch { /* ignore */ }
          reject(err)
        }
      })
      port.postMessage({
        type: 'aiFetch:open',
        payload: {
          reqId,
          url: requestUrlOf(input),
          method: String(init?.method || 'GET'),
          headers,
          body
        }
      })
    })
  }) as typeof globalThis.fetch
}
