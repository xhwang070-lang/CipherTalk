/**
 * AI 作图服务 —— 独立的图像生成配置（AI 助手 generate_image 工具用），与聊天模型分开。
 * 配置存 ConfigService.imageGenConfig；openai/google 协议走 AI SDK generateImage，
 * openai-compatible 走 baseURL + /images/generations，custom 直接请求完整 URL。
 * 直连接口使用 OpenAI 图片生成请求体 + 宽容解析（国内厂商多返回 url 而非 b64_json）。
 * 可在主进程与 AI 子进程复用（ConfigService 在两边都能解析路径）。
 */
import fs from 'fs'
import path from 'path'
import { generateImage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogle } from '@ai-sdk/google'
import { ConfigService } from '../config'
import { isPrivateLanAiHost, resolveAiFetch } from './proxyFetch'

export interface ImageGenConfig {
  enabled: boolean
  protocol: 'openai-compatible' | 'openai' | 'google' | 'custom'
  apiKey: string
  baseURL: string
  model: string
  /** 图片尺寸，如 1024x1024；空 = 由 AI 工具按构图自选（未传时再交服务商默认）。 */
  size: string
  /** 作图请求超时，毫秒。 */
  timeoutMs: number
}

export interface ImageGenResult {
  success: boolean
  /** 生成图片的本地绝对路径（成功时），渲染端用 local-image:// 协议展示 */
  filePath?: string
  mimeType?: string
  error?: string
  width?: number
  height?: number
  sourceWidth?: number
  sourceHeight?: number
}

const DEFAULT_IMAGE_GEN_TIMEOUT_MS = 3_600_000
const MIN_IMAGE_GEN_TIMEOUT_MS = 60000
const MAX_IMAGE_GEN_TIMEOUT_MS = 3_600_000

function normalizeImageGenTimeoutMs(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IMAGE_GEN_TIMEOUT_MS
  return Math.max(MIN_IMAGE_GEN_TIMEOUT_MS, Math.min(MAX_IMAGE_GEN_TIMEOUT_MS, n))
}

function normalizeImageGenConfig(cfg: ImageGenConfig | Partial<ImageGenConfig>): ImageGenConfig {
  return {
    enabled: Boolean(cfg.enabled),
    protocol: cfg.protocol === 'openai' || cfg.protocol === 'google' || cfg.protocol === 'custom' ? cfg.protocol : 'openai-compatible',
    apiKey: String(cfg.apiKey || ''),
    baseURL: String(cfg.baseURL || ''),
    model: String(cfg.model || ''),
    size: String(cfg.size || ''),
    timeoutMs: normalizeImageGenTimeoutMs(cfg.timeoutMs),
  }
}

/** 读取持久化的作图配置。 */
export function getImageGenConfig(): ImageGenConfig {
  const cs = new ConfigService()
  try {
    return normalizeImageGenConfig(cs.get('imageGenConfig'))
  } finally {
    cs.close()
  }
}

/** 写入作图配置（部分字段合并）。 */
export function saveImageGenConfig(patch: Partial<ImageGenConfig>): ImageGenConfig {
  const cs = new ConfigService()
  try {
    const next = normalizeImageGenConfig({ ...cs.get('imageGenConfig'), ...patch })
    cs.set('imageGenConfig', next)
    return next
  } finally {
    cs.close()
  }
}

/** 作图是否可用：启用且配了 key/模型。engine 据此决定是否挂 generate_image 工具。 */
export function isImageGenAvailable(cfg: ImageGenConfig = getImageGenConfig()): boolean {
  return cfg.enabled && Boolean(cfg.apiKey) && Boolean(cfg.model)
}

function imageOutputDir(): string {
  const cs = new ConfigService()
  try {
    const dir = path.join(cs.getCacheBasePath(), 'ai-images')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return dir
  } finally {
    cs.close()
  }
}

function extensionOf(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  return 'png'
}

function saveImageBuffer(data: Uint8Array, mimeType: string): string {
  if (!data || data.byteLength === 0) {
    throw new Error('生成图片数据为空')
  }
  const filePath = path.join(
    imageOutputDir(),
    `img-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${extensionOf(mimeType)}`,
  )
  fs.writeFileSync(filePath, data)
  return filePath
}

function normalizeSize(size?: string): `${number}x${number}` | undefined {
  const value = String(size || '').trim()
  return /^\d+x\d+$/.test(value) ? (value as `${number}x${number}`) : undefined
}

export interface ImageGenSourceImage {
  data: Uint8Array
  mediaType: string
}

function looksLikeGeminiImageModel(model: string): boolean {
  const id = String(model || '').toLowerCase()
  return id.startsWith('gemini-') && id.includes('image')
}

/** Google native image API uses /v1beta. A leftover OpenAI /v1 path 404s. */
export function resolveGoogleImageBaseURL(url?: string | null): string | undefined {
  const trimmed = String(url || '').trim().replace(/\/+$/, '')
  if (!trimmed) return undefined
  if (/\/v1$/i.test(trimmed) && !/v1beta$/i.test(trimmed)) {
    return trimmed.replace(/\/v1$/i, '/v1beta')
  }
  return trimmed
}


const GEMINI_ASPECT_RATIOS: Array<`${number}:${number}`> = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:4', '4:5', '4:1', '1:4',
]

function readPngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || data[0] !== 0x89 || data.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

function readJpegSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null
  let offset = 2
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = data[offset + 1]
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) }
    }
    const length = data.readUInt16BE(offset + 2)
    if (length < 2) break
    offset += 2 + length
  }
  return null
}

function readImageSize(data: Uint8Array): { width: number; height: number } | null {
  const buf = Buffer.from(data)
  return readPngSize(buf) || readJpegSize(buf)
}

function nearestAspectRatio(width: number, height: number): `${number}:${number}` {
  const value = width / height
  let best: `${number}:${number}` = '16:9'
  let bestDiff = Number.POSITIVE_INFINITY
  for (const ratio of GEMINI_ASPECT_RATIOS) {
    const [w, h] = ratio.split(':').map(Number)
    const diff = Math.abs(value - w / h)
    if (diff < bestDiff) {
      best = ratio
      bestDiff = diff
    }
  }
  return best
}

function aspectRatioOf(source?: ImageGenSourceImage): `${number}:${number}` | undefined {
  if (!source) return undefined
  const size = readImageSize(source.data)
  if (!size || size.width <= 0 || size.height <= 0) return undefined
  return nearestAspectRatio(size.width, size.height)
}

function geminiImageSize(width: number, height: number): '1K' | '2K' | '4K' {
  const long = Math.max(width, height)
  if (long >= 2560) return '4K'
  if (long >= 1024) return '2K'
  return '1K'
}

async function fitEditedImageToSource(
  generated: Uint8Array,
  source: ImageGenSourceImage,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const src = readImageSize(source.data)
  if (!src) return null
  const out = readImageSize(generated)
  if (out && out.width === src.width && out.height === src.height) {
    console.warn(`[image-gen] edit output already ${out.width}x${out.height}`)
    return null
  }
  try {
    const sharp = (await import('sharp')).default
    const jpeg = /jpeg|jpg/i.test(source.mediaType)
    const pipeline = sharp(Buffer.from(generated)).resize(src.width, src.height, {
      fit: 'cover',
      position: 'centre',
    })
    const data = jpeg
      ? await pipeline.jpeg({ quality: 92 }).toBuffer()
      : await pipeline.png().toBuffer()
    console.warn(`[image-gen] edit fitted ${out ? `${out.width}x${out.height}` : '?'} -> ${src.width}x${src.height}`)
    return { data, mimeType: jpeg ? 'image/jpeg' : 'image/png' }
  } catch (error) {
    console.warn('[image-gen] edit fit failed, keep generated size', error)
    return null
  }
}

/** openai / google: AI SDK generateImage. Pass sourceImage to edit an existing picture. */
async function generateViaAiSdk(prompt: string, cfg: ImageGenConfig, size?: string, signal?: AbortSignal, sourceImage?: ImageGenSourceImage): Promise<ImageGenResult> {
  const baseURL = cfg.protocol === 'google'
    ? resolveGoogleImageBaseURL(cfg.baseURL)
    : (String(cfg.baseURL || '').trim() || undefined)
  const fetch = resolveAiFetch(baseURL || cfg.baseURL)
  const model = cfg.protocol === 'google'
    ? createGoogle({ apiKey: cfg.apiKey, baseURL, name: 'image-gen', fetch }).imageModel(cfg.model)
    : createOpenAI({ apiKey: cfg.apiKey, baseURL, name: 'image-gen', fetch }).imageModel(cfg.model)

  const dim = sourceImage ? readImageSize(sourceImage.data) : null
  const editRatio = aspectRatioOf(sourceImage)
  if (sourceImage) {
    console.warn(`[image-gen] edit source=${dim?.width || '?'}x${dim?.height || '?'} aspectRatio=${editRatio || 'none'}`)
  }
  const editText = sourceImage
    ? `${prompt}\n\n保持原图构图和画布，不要改变长宽比，不要加边或留白。`
    : prompt
  const { image } = await generateImage({
    model,
    prompt: sourceImage
      ? { text: editText, images: [sourceImage.data] }
      : prompt,
    n: 1,
    ...(sourceImage
      ? (editRatio ? { aspectRatio: editRatio } : {})
      : { size: normalizeSize(size || cfg.size) }),
    ...(sourceImage && editRatio && dim
      ? {
          providerOptions: {
            google: {
              imageConfig: {
                aspectRatio: editRatio,
                imageSize: geminiImageSize(dim.width, dim.height),
              },
            },
          },
        }
      : {}),
    maxRetries: 0,
    abortSignal: signal,
  })

  if (!image.uint8Array || image.uint8Array.byteLength === 0) {
    return { success: false, error: '作图接口返回成功，但 AI SDK 未返回有效图片数据（图片字节为空）' }
  }
  let bytes: Uint8Array = image.uint8Array
  let mimeType = image.mediaType || 'image/png'
  if (sourceImage) {
    const fitted = await fitEditedImageToSource(bytes, sourceImage)
    if (fitted) {
      bytes = fitted.data
      mimeType = fitted.mimeType
    }
  }
  const out = readImageSize(bytes)
  const src = sourceImage ? readImageSize(sourceImage.data) : null
  if (sourceImage) {
    console.warn(`[image-gen] edit result ${out ? `${out.width}x${out.height}` : '?'} source=${src ? `${src.width}x${src.height}` : '?'}`)
  }
  return {
    success: true,
    filePath: saveImageBuffer(bytes, mimeType),
    mimeType,
    width: out?.width,
    height: out?.height,
    sourceWidth: src?.width,
    sourceHeight: src?.height,
  }
}

/**
 * openai-compatible 协议：直连 /images/generations。
 * 不带 response_format（部分厂商会拒绝），响应同时兼容 data[].b64_json / data[].url / images[].url。
 */
async function generateViaCompatible(prompt: string, cfg: ImageGenConfig, size?: string, signal?: AbortSignal): Promise<ImageGenResult> {
  if (!cfg.baseURL) return { success: false, error: cfg.protocol === 'custom' ? '未配置作图完整接口地址' : '未配置作图接口地址' }
  const fetchImpl = resolveAiFetch(cfg.baseURL) || fetch
  const endpoint = cfg.protocol === 'custom'
    ? cfg.baseURL.trim()
    : `${cfg.baseURL.trim().replace(/\/+$/, '')}/images/generations`
  const sizeValue = normalizeSize(size || cfg.size)

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      prompt,
      n: 1,
      ...(sizeValue ? { size: sizeValue, image_size: sizeValue } : {}),
    }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = `HTTP ${response.status}`
    try {
      const payload = JSON.parse(text)
      message = payload?.error?.message || payload?.message || message
    } catch { /* 用原始状态码 */ }
    if (response.status === 404) {
      return { success: false, error: `作图接口不存在（404）。OpenAI 兼容作图走 /images/generations；gemini-3.7-flash 是对话模型，请换成 Kolors / gpt-image-1 / imagen 等作图模型。` }
    }
    if (response.status === 429) {
      return { success: false, error: `作图被限流或额度用完（429）：${message}` }
    }
    return { success: false, error: `作图请求失败: ${message}` }
  }

  const payload: any = await response.json().catch(() => null)
  const item = payload?.data?.[0] || payload?.images?.[0]
  const b64 = String(item?.b64_json || '').trim()
  if (b64) {
    const data = Buffer.from(b64, 'base64')
    if (data.byteLength === 0) {
      return { success: false, error: '作图接口返回成功，但 b64_json 解码后为空' }
    }
    return { success: true, filePath: saveImageBuffer(data, 'image/png'), mimeType: 'image/png' }
  }
  const url = String(item?.url || '').trim()
  if (url) {
    const imageResponse = await fetchImpl(url, { signal })
    if (!imageResponse.ok) return { success: false, error: `下载生成图片失败: HTTP ${imageResponse.status}` }
    const mimeType = imageResponse.headers.get('content-type')?.split(';')[0] || 'image/png'
    const data = new Uint8Array(await imageResponse.arrayBuffer())
    if (data.byteLength === 0) {
      return { success: false, error: '下载生成图片失败：图片响应为空' }
    }
    return { success: true, filePath: saveImageBuffer(data, mimeType), mimeType }
  }
  return { success: false, error: '作图接口返回成功，但未找到图片数据（b64_json/url 均为空）' }
}

function isTransientImageGenError(message: string): boolean {
  return /503|service unavailable|overloaded|unavailable|429|rate.?limit|temporarily|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message)
}

export function describeImageGenError(message: string): string {
  const raw = String(message || '').trim()
  if (/503|service unavailable|overloaded/i.test(raw)) {
    return '\u4f5c\u56fe\u670d\u52a1\u6682\u65f6\u5fd9\uff08503\uff09\uff0c\u8fc7\u4e00\u4e24\u5206\u949f\u518d\u8bd5\u4e00\u6b21\u3002'
  }
  if (/429|rate.?limit/i.test(raw)) {
    return '\u4f5c\u56fe\u63a5\u53e3\u9650\u6d41\u4e86\uff0c\u7a0d\u540e\u518d\u8bd5\u3002'
  }
  if (/Failed after \d+ attempts/i.test(raw) && isTransientImageGenError(raw)) {
    return '\u4f5c\u56fe\u670d\u52a1\u6682\u65f6\u5fd9\uff0c\u8fc7\u4e00\u4e24\u5206\u949f\u518d\u8bd5\u4e00\u6b21\u3002'
  }
  return raw || '\u4f5c\u56fe\u5931\u8d25'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 生成图片并落盘。cfg 缺省读持久化配置（测试时传 overrides）。 */
export async function generateImageToFile(
  prompt: string,
  options: { size?: string; config?: Partial<ImageGenConfig>; signal?: AbortSignal; sourceImage?: ImageGenSourceImage } = {},
): Promise<ImageGenResult> {
  const cfg = normalizeImageGenConfig({ ...getImageGenConfig(), ...options.config })
  if (!cfg.apiKey) return { success: false, error: '未配置作图 API Key' }
  if (!cfg.model) return { success: false, error: '未配置作图模型' }
  const input = String(prompt || '').trim()
  if (!input) return { success: false, error: '作图提示词为空' }

  const controller = new AbortController()
  const timeoutMs = normalizeImageGenTimeoutMs(cfg.timeoutMs)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  options.signal?.addEventListener('abort', () => controller.abort())

  try {
    const sourceImage = options.sourceImage
    const runOnce = async (): Promise<ImageGenResult> => {
      if (sourceImage && (cfg.protocol === 'openai-compatible' || cfg.protocol === 'custom')) {
        if (looksLikeGeminiImageModel(cfg.model)) {
          return await generateViaAiSdk(input, { ...cfg, protocol: 'google' }, options.size, controller.signal, sourceImage)
        }
        return { success: false, error: '当前作图协议不支持改图。请把协议改成 Google Gemini，模型用 gemini-3.1-flash-image，地址填 /v1beta（例如 http://127.0.0.1:8045/v1beta）。' }
      }
      if (cfg.protocol === 'openai-compatible' || cfg.protocol === 'custom') {
        return await generateViaCompatible(input, cfg, options.size, controller.signal)
      }
      return await generateViaAiSdk(input, cfg, options.size, controller.signal, sourceImage)
    }
    const delays = [0, 2000, 5000, 10000]
    let last: ImageGenResult | undefined
    for (let i = 0; i < delays.length; i += 1) {
      if (i > 0) {
        console.warn(`[image-gen] retry ${i} after ${last?.error || 'error'}`)
        await sleep(delays[i])
      }
      if (controller.signal.aborted) break
      try {
        last = await runOnce()
        if (last.success) return last
        if (!isTransientImageGenError(last.error || '')) {
          return { ...last, error: describeImageGenError(last.error || '作图失败') }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        last = { success: false, error: message }
        if (!isTransientImageGenError(message) || i === delays.length - 1) throw error
      }
    }
    return { success: false, error: describeImageGenError(last?.error || '作图失败') }
  } catch (e) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      return { success: false, error: `作图请求超时（>${Math.round(timeoutMs / 1000)}秒），请稍后重试` }
    }
    const message = e instanceof Error ? e.message : String(e)
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(message)) {
      const where = String(cfg.baseURL || '').trim() || '作图接口'
      if (isPrivateLanAiHost(cfg.baseURL)) {
        return { success: false, error: `连不上本机作图接口 ${where}。请确认反重力/中转已启动；本机地址不应走系统代理。` }
      }
      return { success: false, error: `连不上作图接口 ${where}（${message}）。检查地址、网络或代理。` }
    }
    if (/not found/i.test(message) && (cfg.protocol === 'google' || looksLikeGeminiImageModel(cfg.model))) {
      return { success: false, error: '作图接口 404。Google 协议请把地址改成 /v1beta（例如 http://127.0.0.1:8045/v1beta），不要填 OpenAI 兼容的 /v1。' }
    }
    return { success: false, error: describeImageGenError(message) }
  } finally {
    clearTimeout(timeout)
  }
}


function looksLikeImageModelId(id: string): boolean {
  return /image|imagen|kolors|kolor|dall-e|dalle|flux|banana|gpt-image|sdxl|stable-diffusion/i.test(id)
}

function originFromBaseURL(url: string): string {
  try {
    const parsed = new URL(String(url || '').trim())
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return ''
  }
}

function quotaModelName(item: unknown): string {
  if (typeof item === 'string') return item.trim()
  if (!item || typeof item !== 'object') return ''
  const rec = item as Record<string, unknown>
  return String(rec.name || rec.id || rec.model || rec.model_id || '').trim()
}

function quotaModelUsable(item: unknown): boolean {
  if (typeof item === 'string') return Boolean(item.trim())
  if (!item || typeof item !== 'object') return false
  const rec = item as Record<string, unknown>
  const percentage = Number(rec.percentage)
  if (Number.isFinite(percentage) && percentage <= 0) return false
  const remaining = Number(rec.remaining_fraction ?? rec.remaining)
  if (Number.isFinite(remaining) && remaining <= 0) return false
  return Boolean(quotaModelName(item))
}

function extractQuotaImageModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  const accounts = Array.isArray(obj.accounts) ? obj.accounts : Array.isArray(payload) ? payload : []
  const ids = new Set<string>()
  for (const account of accounts) {
    if (!account || typeof account !== 'object') continue
    const rec = account as Record<string, unknown>
    if (rec.disabled === true) continue
    const quota = rec.quota && typeof rec.quota === 'object' ? rec.quota as Record<string, unknown> : null
    if (quota?.is_forbidden === true) continue
    const models = Array.isArray(quota?.models) ? quota.models : []
    for (const model of models) {
      if (!quotaModelUsable(model)) continue
      const name = quotaModelName(model)
      if (name && looksLikeImageModelId(name)) ids.add(name)
    }
  }
  return Array.from(ids).sort((a, b) => a.localeCompare(b))
}

async function listLocalQuotaImageModels(
  origin: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string[] | null> {
  if (!origin || !apiKey) return null
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-admin-token': apiKey,
    'x-goog-api-key': apiKey,
  }
  for (const path of ['/api/accounts', '/accounts']) {
    try {
      const res = await fetchImpl(`${origin}${path}`, { method: 'GET', headers, signal })
      if (!res.ok) continue
      const payload = JSON.parse(await res.text().catch(() => '{}') || '{}')
      if (!payload || typeof payload !== 'object') continue
      const obj = payload as Record<string, unknown>
      if (!Array.isArray(obj.accounts) && !Array.isArray(payload)) continue
      return extractQuotaImageModels(payload)
    } catch {
      continue
    }
  }
  return null
}

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  const nested = obj.data && typeof obj.data === 'object' ? obj.data as Record<string, unknown> : null
  const raw = Array.isArray(obj.models)
    ? obj.models
    : Array.isArray(obj.data)
      ? obj.data
      : Array.isArray(nested?.data)
        ? nested.data
        : Array.isArray(nested?.models)
          ? nested.models
          : []
  const ids = raw
    .map((item: unknown) => {
      if (typeof item === 'string') return item.replace(/^models\//, '').trim()
      if (!item || typeof item !== 'object') return ''
      const rec = item as Record<string, unknown>
      return String(rec.id || rec.name || '').replace(/^models\//, '').trim()
    })
    .filter(Boolean)
  return Array.from(new Set(ids))
}

function resolveModelsEndpoint(cfg: ImageGenConfig): string {
  if (cfg.protocol === 'custom') {
    const u = String(cfg.baseURL || '').trim().replace(/\/+$/, '')
    if (!u) throw new Error('请先填写完整接口地址')
    if (/\/images\/generations$/i.test(u)) return u.replace(/\/images\/generations$/i, '/models')
    return `${u.replace(/\/[^/]+$/, '')}/models`
  }
  const base = cfg.protocol === 'google'
    ? (resolveGoogleImageBaseURL(cfg.baseURL) || String(cfg.baseURL || '').trim())
    : String(cfg.baseURL || '').trim()
  const normalized = base.replace(/\/+$/, '')
  if (!normalized) {
    if (cfg.protocol === 'google') return 'https://generativelanguage.googleapis.com/v1beta/models'
    if (cfg.protocol === 'openai') return 'https://api.openai.com/v1/models'
    throw new Error('请先填写接口地址')
  }
  return `${normalized}/models`
}

/** 从当前作图接口拉模型列表，和 AI 接入的刷新同一套路。生图相关型号排前面。 */
export async function listImageGenModels(cfg: Partial<ImageGenConfig> = {}): Promise<{ success: boolean; models?: string[]; error?: string }> {
  const normalized = normalizeImageGenConfig({ ...getImageGenConfig(), ...cfg })
  if (!normalized.apiKey && normalized.protocol !== 'custom') {
    return { success: false, error: '请先填写 API Key' }
  }
  let url: string
  try {
    url = resolveModelsEndpoint(normalized)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
  const fetchImpl = resolveAiFetch(normalized.baseURL) || fetch
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (normalized.apiKey) {
    headers.Authorization = `Bearer ${normalized.apiKey}`
    headers['x-goog-api-key'] = normalized.apiKey
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const origin = originFromBaseURL(normalized.baseURL) || originFromBaseURL(url)
    const quotaModels = await listLocalQuotaImageModels(origin, normalized.apiKey, fetchImpl, controller.signal)
    if (quotaModels) {
      if (quotaModels.length === 0) {
        return { success: false, error: '当前中转账号没有可用的生图额度。对话模型不会出现在这里。' }
      }
      return { success: true, models: quotaModels }
    }
    let res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    let text = await res.text().catch(() => '')
    if (!res.ok && normalized.protocol === 'google' && /\/v1beta\/models$/i.test(url)) {
      const fallback = url.replace(/\/v1beta\/models$/i, '/v1/models')
      res = await fetchImpl(fallback, { method: 'GET', headers, signal: controller.signal })
      text = await res.text().catch(() => '')
    }
    if (!res.ok) {
      return { success: false, error: `刷新模型失败：HTTP ${res.status} ${(text || res.statusText).slice(0, 180)}` }
    }
    let payload: unknown = {}
    try {
      payload = JSON.parse(text || '{}')
    } catch {
      return { success: false, error: '模型列表不是 JSON，也可以手动输入模型名。' }
    }
    const models = extractModelIds(payload).filter(looksLikeImageModelId).sort((a, b) => a.localeCompare(b))
    if (models.length === 0) return { success: false, error: '接口里没有可调用的生图型号。也可以手动输入模型名后保存。' }
    return { success: true, models }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/abort/i.test(message)) return { success: false, error: '刷新模型超时' }
    return { success: false, error: `刷新模型失败：${message.slice(0, 180)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 测试配置：真实生成一张小图验证全链路（会消耗少量额度）。 */
export async function testImageGenConfig(cfg: Partial<ImageGenConfig>): Promise<ImageGenResult> {
  return generateImageToFile('一只可爱的橘猫，扁平插画风格', { size: '512x512', config: cfg })
}
