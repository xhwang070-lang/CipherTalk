import { generateText, jsonSchema, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createProxyFetch, getResolvedProxyUrl, isCloudflareOrHtmlBody, resolveAiFetch } from '../proxyFetch'
import { withOpenAICompatibleStreamSanitizer } from '../openaiCompatibleStreamSanitizer'
import { withOpenAIResponsesSanitizer } from '../openaiResponsesSanitizer'
import { CODEX_SUBSCRIPTION_DUMMY_API_KEY, createCodexSubscriptionFetch, getCodexSubscriptionAuthPath } from '../codexSubscriptionAuth'

export namespace OpenAI {
  export namespace Chat {
    export type ChatCompletionMessageParam = ModelMessage | {
      role: 'system' | 'user' | 'assistant' | 'tool'
      content?: string | null
      name?: string
      tool_call_id?: string
      tool_calls?: ChatCompletionMessageToolCall[]
    }

    export type ChatCompletionTool = {
      type: 'function'
      function: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
      }
    }

    export type ChatCompletionToolChoiceOption =
      | 'none'
      | 'auto'
      | 'required'
      | {
          type: 'function'
          function: {
            name: string
          }
        }

    export type ChatCompletionMessageToolCall = {
      id: string
      type: 'function'
      function: {
        name: string
        arguments: string
      }
    }

    export type ChatCompletionMessage = {
      role: 'assistant'
      content?: string | null
      tool_calls?: ChatCompletionMessageToolCall[]
      reasoning_content?: string | null
    }
  }
}

export interface AIStreamToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type AIStreamEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'content_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; delta: unknown }
  | { type: 'tool_call_done'; toolCall: AIStreamToolCall }
  | { type: 'tool_result'; toolCallId?: string; toolName: string; result: unknown; error?: string }
  | { type: 'round_start' }
  | {
      type: 'message_done'
      content: string
      reasoningContent?: string
      toolCalls?: AIStreamToolCall[]
      finishReason?: string | null
    }

/**
 * AI 提供商基础接口
 */
export interface AIProvider {
  name: string
  displayName: string
  models: string[]
  pricing: {
    input: number
    output: number
  }

  /**
   * 非流式聊天
   */
  chat(messages: OpenAI.Chat.ChatCompletionMessageParam[], options?: ChatOptions): Promise<string>

  /**
   * 原生工具调用
   */
  chatWithTools(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatWithToolsOptions
  ): Promise<NativeToolCallResult>

  /**
   * 原生工具调用（流式接收工具调用前的 assistant 文本）
   */
  streamChatWithTools?(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatWithToolsOptions,
    onEvent: (event: AIStreamEvent) => void
  ): Promise<NativeToolCallResult>

  /**
   * 流式聊天
   */
  streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onEvent: (event: AIStreamEvent) => void
  ): Promise<void>

  /**
   * 测试连接
   */
  testConnection(model?: string): Promise<{ success: boolean; error?: string; needsProxy?: boolean }>

  /**
   * 拉取服务商当前可用模型列表
   */
  listModels(): Promise<string[]>

  /**
   * 获取模型去重用的真实 ID
   */
  getModelIdentity(model: string): string
}

/**
 * 聊天选项
 */
export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  enableThinking?: boolean
}

export type NativeToolDefinition = OpenAI.Chat.ChatCompletionTool

export interface ChatWithToolsOptions extends ChatOptions {
  tools: NativeToolDefinition[]
  toolChoice?: OpenAI.Chat.ChatCompletionToolChoiceOption
  parallelToolCalls?: boolean
}

export interface NativeToolCallResult {
  message: OpenAI.Chat.ChatCompletionMessage & { reasoning_content?: string | null }
  finishReason?: string | null
}

export type ProviderKind = 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription'
type MutableToolCall = AIStreamToolCall

export const NATIVE_TOOL_CALLING_UNSUPPORTED_MESSAGE = '当前模型/服务商不支持原生工具调用，请切换支持 tools 的 OpenAI-compatible 模型'

function normalizeModelMessage(message: OpenAI.Chat.ChatCompletionMessageParam): ModelMessage {
  const raw = message as any
  const role = raw.role
  const content = raw.content ?? ''

  if (role === 'system') {
    return { role: 'system', content: String(content) }
  }
  if (role === 'assistant') {
    return { role: 'assistant', content: typeof content === 'string' ? content : '' }
  }
  if (role === 'tool') {
    return {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: String(raw.tool_call_id || 'tool-call'),
        toolName: String(raw.name || 'tool'),
        output: { type: 'text', value: String(content) }
      }]
    } as ModelMessage
  }

  return { role: 'user', content: typeof content === 'string' ? content : String(content || '') }
}

function normalizeMessages(messages: OpenAI.Chat.ChatCompletionMessageParam[]): ModelMessage[] {
  return messages.map(normalizeModelMessage)
}

function toAiToolSet(tools: NativeToolDefinition[]): ToolSet {
  const result: ToolSet = {}
  for (const item of tools || []) {
    const name = item?.function?.name
    if (!name) continue
    result[name] = tool({
      description: item.function.description,
      inputSchema: jsonSchema((item.function.parameters || { type: 'object', properties: {} }) as any)
    }) as any
  }
  return result
}

function toAiToolChoice(choice?: OpenAI.Chat.ChatCompletionToolChoiceOption): any {
  if (!choice || typeof choice === 'string') return choice
  const toolName = choice.function?.name
  return toolName ? { type: 'tool', toolName } : 'auto'
}

function toOpenAIToolCall(call: any, fallbackIndex = 0): AIStreamToolCall {
  return {
    id: String(call?.toolCallId || call?.id || `tool-call-${fallbackIndex}`),
    type: 'function',
    function: {
      name: String(call?.toolName || call?.name || ''),
      arguments: JSON.stringify(call?.input ?? call?.args ?? {})
    }
  }
}

function getToolCallIndex(delta: unknown, fallback: number): number {
  const value = typeof delta === 'object' && delta && 'index' in delta
    ? Number((delta as { index?: unknown }).index)
    : NaN
  return Number.isInteger(value) ? value : fallback
}

function appendToolCallDelta(existing: MutableToolCall | undefined, delta: any, index: number): MutableToolCall {
  const next: MutableToolCall = existing || {
    id: '',
    type: 'function',
    function: { name: '', arguments: '' }
  }

  next.id = next.id || delta.id || `tool-call-${index}`
  next.type = 'function'
  if (delta.function?.name) next.function.name += delta.function.name
  if (delta.function?.arguments) next.function.arguments += delta.function.arguments
  return next
}

function collectToolCalls(toolCallByIndex: Map<number, MutableToolCall>): AIStreamToolCall[] {
  return Array.from(toolCallByIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, toolCall], index) => ({
      id: toolCall.id || `tool-call-${index}`,
      type: 'function' as const,
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments
      }
    }))
}

function parseSseLine(line: string): any | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function* iterateSseJson(response: Response): AsyncGenerator<any> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() || ''
    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        const parsed = parseSseLine(line)
        if (parsed) yield parsed
      }
    }
  }

  if (buffer) {
    for (const line of buffer.split(/\r?\n/)) {
      const parsed = parseSseLine(line)
      if (parsed) yield parsed
    }
  }
}

function normalizeBaseURL(baseURL: string): string {
  return String(baseURL || '').trim().replace(/\/+$/, '')
}

export function joinEndpoint(baseURL: string, path: string): string {
  const normalized = normalizeBaseURL(baseURL)
  return `${normalized}${path.startsWith('/') ? path : `/${path}`}`
}

function isNativeToolCallingUnsupportedError(error: unknown): boolean {
  const status = typeof error === 'object' && error && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined
  const message = error instanceof Error ? error.message : String(error || '')
  const lower = message.toLowerCase()

  return (
    status === 400
    || status === 404
    || status === 422
  ) && (
    lower.includes('tool')
    || lower.includes('tool_choice')
    || lower.includes('tool_calls')
    || lower.includes('function_call')
    || lower.includes('function calling')
    || lower.includes('functions')
    || lower.includes('unsupported parameter')
    || lower.includes('unknown parameter')
    || lower.includes('unrecognized request argument')
  )
}

export { isNativeToolCallingUnsupportedError }

// 部分模型（如 kimi-k2.6）拒绝自定义 temperature，报错格式类似 "invalid temperature: only 1 is allowed for this model"
function isUnsupportedTemperatureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  const lower = message.toLowerCase()
  return lower.includes('temperature') && lower.includes('only 1 is allowed')
}

// 命中一次后记住，同一 provider+model 后续请求直接跳过自定义 temperature，避免每次都白打一次请求再重试
const unsupportedTemperatureModels = new Set<string>()

function temperatureCacheKey(providerName: string, model: string): string {
  return `${providerName}::${model}`
}

export function normalizeNativeToolCallingError(error: unknown): Error {
  if (isNativeToolCallingUnsupportedError(error)) {
    return new Error(NATIVE_TOOL_CALLING_UNSUPPORTED_MESSAGE)
  }

  return error instanceof Error ? error : new Error(String(error || '模型工具调用失败'))
}

/**
 * AI 提供商抽象基类
 */
export abstract class BaseAIProvider implements AIProvider {
  abstract name: string
  abstract displayName: string
  abstract models: string[]
  abstract pricing: { input: number; output: number }

  protected apiKey: string
  protected baseURL: string
  protected providerKind: ProviderKind

  constructor(apiKey: string, baseURL: string, providerKind: ProviderKind = 'openai-compatible', protected authFilePath?: string) {
    this.apiKey = providerKind === 'codex-subscription' ? CODEX_SUBSCRIPTION_DUMMY_API_KEY : apiKey
    this.baseURL = baseURL
    this.providerKind = providerKind
  }

  protected getDefaultHeaders(): Record<string, string> | undefined {
    return undefined
  }

  protected getModelProvider(model: string): LanguageModel {
    const headers = this.getDefaultHeaders()
    const fetch = resolveAiFetch(this.baseURL)
    if (this.providerKind === 'codex-subscription') {
      const subscriptionFetch = createCodexSubscriptionFetch({
        authFilePath: this.authFilePath || getCodexSubscriptionAuthPath(),
        baseFetch: fetch,
      })
      return createOpenAI({
        apiKey: CODEX_SUBSCRIPTION_DUMMY_API_KEY,
        baseURL: 'https://api.openai.com/v1',
        name: this.name,
        fetch: withOpenAIResponsesSanitizer(subscriptionFetch),
      }).responses(model as any)
    }
    if (this.providerKind === 'anthropic') {
      return createAnthropic({
        apiKey: this.apiKey,
        baseURL: this.baseURL || undefined,
        name: this.name,
        headers,
        fetch
      })(model as any)
    }
    if (this.providerKind === 'google') {
      return createGoogle({
        apiKey: this.apiKey,
        baseURL: this.baseURL || undefined,
        name: this.name,
        headers,
        fetch
      })(model as any)
    }
    if (this.providerKind === 'openai-responses') {
      return createOpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseURL || undefined,
        name: this.name,
        headers,
        fetch: withOpenAIResponsesSanitizer(fetch)
      }).responses(model as any)
    }

    return createOpenAICompatible({
      name: this.name,
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      headers,
      includeUsage: true,
      fetch: withOpenAICompatibleStreamSanitizer(fetch)
    }).chatModel(model)
  }

  /**
   * 兼容旧 provider 覆写逻辑的轻量 OpenAI-compatible client。
   * 新路径优先使用 AI SDK；少数有厂商特殊流式字段的 provider 暂时通过这里保留行为。
   */
  protected async getClient(): Promise<any> {
    const defaultHeaders = this.getDefaultHeaders() || {}
    const authHeaders = this.providerKind === 'anthropic'
      ? { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
      : this.providerKind === 'google'
        ? { 'x-goog-api-key': this.apiKey }
        : { Authorization: `Bearer ${this.apiKey}` }
    const headers = {
      'content-type': 'application/json',
      ...authHeaders,
      ...defaultHeaders
    }

    const requestJson = async (path: string, init?: RequestInit) => {
      const fetchImpl = resolveAiFetch(this.baseURL) || fetch
      const response = await fetchImpl(joinEndpoint(this.baseURL, path), {
        ...init,
        headers: {
          ...headers,
          ...(init?.headers as Record<string, string> | undefined)
        }
      })
      const text = await response.text().catch(() => '')
      if (isCloudflareOrHtmlBody(text)) {
        const error: any = new Error('中转站被 Cloudflare 拦截。多半是系统代理 IP 被拦，密语对自定义接口已改为直连。请再点一次刷新；仍失败可手动输入模型名后保存。')
        error.status = response.status
        throw error
      }
      if (!response.ok) {
        const error: any = new Error(text.slice(0, 300) || `${response.status} ${response.statusText}`)
        error.status = response.status
        throw error
      }
      return {
        json: async () => JSON.parse(text || '{}'),
        text: async () => text,
        ok: true,
        status: response.status
      }
    }

    return {
      models: {
        list: async () => {
          const response = await requestJson('/models', { method: 'GET' })
          return response.json()
        }
      },
      chat: {
        completions: {
          create: async (params: any) => {
            const response = await requestJson('/chat/completions', {
              method: 'POST',
              body: JSON.stringify(params)
            })
            if (params?.stream) {
              return iterateSseJson(response)
            }
            return response.json()
          }
        }
      }
    }
  }

  protected resolveModelId(displayName: string): string {
    return displayName
  }

  protected getRequestedModel(options?: ChatOptions): string {
    const model = String(options?.model || this.models[0] || '').trim()
    if (!model) {
      throw new Error('未配置模型，请先选择或输入模型名称')
    }
    return this.resolveModelId(model)
  }

  getModelIdentity(model: string): string {
    return String(this.resolveModelId(model) || model || '').trim().toLowerCase()
  }

  protected getChatRequestExtraParams(_options?: ChatOptions): Record<string, unknown> {
    return {}
  }

  protected getToolRequestExtraParams(_options: ChatWithToolsOptions): Record<string, unknown> {
    return {}
  }

  async listModels(): Promise<string[]> {
    if (!this.baseURL) {
      return this.models
    }

    const client = await this.getClient()
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('MODEL_LIST_TIMEOUT')), 15000)
    })

    const response: any = await Promise.race([
      client.models.list(),
      timeoutPromise
    ])

    const rawItems = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.models)
        ? response.models
        : Array.isArray(response?.data?.data)
          ? response.data.data
          : Array.isArray(response?.data?.models)
            ? response.data.models
            : []

    const ids = Array.isArray(rawItems)
      ? rawItems
        .map((item: any) => String(item?.id || item?.name || '').replace(/^models\//, '').trim())
        .filter(Boolean)
      : []

    return Array.from(new Set(ids))
  }

  async chat(messages: OpenAI.Chat.ChatCompletionMessageParam[], options?: ChatOptions): Promise<string> {
    const model = this.getRequestedModel(options)
    const modelProvider = this.getModelProvider(model)
    const normalized = normalizeMessages(messages)
    const cacheKey = temperatureCacheKey(this.name, model)
    let temperature: number | undefined = unsupportedTemperatureModels.has(cacheKey)
      ? undefined
      : (options?.temperature ?? 0.7)

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await generateText({
          model: modelProvider,
          messages: normalized,
          allowSystemInMessages: true,
          temperature,
          maxOutputTokens: options?.maxTokens,
          timeout: 300000,
          maxRetries: 0,
          telemetry: { functionId: 'provider-chat' }
        })
        return response.text || ''
      } catch (error) {
        if (attempt === 0 && temperature !== undefined && isUnsupportedTemperatureError(error)) {
          unsupportedTemperatureModels.add(cacheKey)
          temperature = undefined
          continue
        }
        throw error
      }
    }
  }

  async chatWithTools(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatWithToolsOptions
  ): Promise<NativeToolCallResult> {
    const model = this.getRequestedModel(options)
    const modelProvider = this.getModelProvider(model)
    const normalized = normalizeMessages(messages)
    const cacheKey = temperatureCacheKey(this.name, model)
    let temperature: number | undefined = unsupportedTemperatureModels.has(cacheKey)
      ? undefined
      : (options?.temperature ?? 0.2)

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await generateText({
          model: modelProvider,
          messages: normalized,
          allowSystemInMessages: true,
          temperature,
          maxOutputTokens: options?.maxTokens,
          timeout: 300000,
          maxRetries: 0,
          tools: toAiToolSet(options.tools),
          toolChoice: toAiToolChoice(options.toolChoice),
          telemetry: { functionId: 'provider-chat-tools' }
        } as any)

        const toolCalls = (response.toolCalls || []).map(toOpenAIToolCall)
        return {
          message: {
            role: 'assistant',
            content: response.text || null,
            reasoning_content: response.reasoningText || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
          },
          finishReason: response.finishReason || null
        }
      } catch (error) {
        if (attempt === 0 && temperature !== undefined && isUnsupportedTemperatureError(error)) {
          unsupportedTemperatureModels.add(cacheKey)
          temperature = undefined
          continue
        }
        throw normalizeNativeToolCallingError(error)
      }
    }
  }

  async streamChatWithTools(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatWithToolsOptions,
    onEvent: (event: AIStreamEvent) => void
  ): Promise<NativeToolCallResult> {
    const model = this.getRequestedModel(options)
    const modelProvider = this.getModelProvider(model)
    const normalized = normalizeMessages(messages)
    const cacheKey = temperatureCacheKey(this.name, model)
    let temperature: number | undefined = unsupportedTemperatureModels.has(cacheKey)
      ? undefined
      : (options?.temperature ?? 0.2)

    for (let attempt = 0; ; attempt++) {
      let emitted = false
      try {
        const result = streamText({
          model: modelProvider,
          messages: normalized,
          allowSystemInMessages: true,
          temperature,
          maxOutputTokens: options?.maxTokens,
          timeout: 300000,
          maxRetries: 0,
          tools: toAiToolSet(options.tools),
          toolChoice: toAiToolChoice(options.toolChoice),
          telemetry: { functionId: 'provider-stream-chat-tools' }
        } as any)

        let content = ''
        let reasoningContent = ''
        let finishReason: string | null = null
        const toolCalls: AIStreamToolCall[] = []
        const toolInputById = new Map<string, string>()
        const toolNameById = new Map<string, string>()

        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            emitted = true
            content += part.text
            onEvent({ type: 'content_delta', text: part.text })
          } else if (part.type === 'reasoning-delta') {
            emitted = true
            reasoningContent += part.text
            onEvent({ type: 'reasoning_delta', text: part.text })
          } else if (part.type === 'tool-input-start') {
            toolNameById.set(part.id, part.toolName)
          } else if (part.type === 'tool-input-delta') {
            emitted = true
            const previous = toolInputById.get(part.id) || ''
            toolInputById.set(part.id, previous + part.delta)
            onEvent({ type: 'tool_call_delta', index: toolInputById.size - 1, delta: part })
          } else if (part.type === 'tool-call') {
            emitted = true
            const toolCall = toOpenAIToolCall(part, toolCalls.length)
            toolCalls.push(toolCall)
            onEvent({ type: 'tool_call_done', toolCall })
          } else if (part.type === 'finish-step' || part.type === 'finish') {
            finishReason = part.finishReason || finishReason
          } else if (part.type === 'error') {
            throw part.error
          }
        }

        for (const [id, args] of toolInputById.entries()) {
          if (toolCalls.some(item => item.id === id)) continue
          const toolCall: AIStreamToolCall = {
            id,
            type: 'function',
            function: {
              name: toolNameById.get(id) || '',
              arguments: args
            }
          }
          toolCalls.push(toolCall)
          onEvent({ type: 'tool_call_done', toolCall })
        }

        onEvent({
          type: 'message_done',
          content,
          reasoningContent: reasoningContent || undefined,
          toolCalls,
          finishReason
        })

        return {
          message: {
            role: 'assistant',
            content: content || null,
            reasoning_content: reasoningContent || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
          },
          finishReason
        }
      } catch (error) {
        if (attempt === 0 && !emitted && temperature !== undefined && isUnsupportedTemperatureError(error)) {
          unsupportedTemperatureModels.add(cacheKey)
          temperature = undefined
          continue
        }
        throw normalizeNativeToolCallingError(error)
      }
    }
  }

  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onEvent: (event: AIStreamEvent) => void
  ): Promise<void> {
    const model = this.getRequestedModel(options)
    const modelProvider = this.getModelProvider(model)
    const normalized = normalizeMessages(messages)
    const cacheKey = temperatureCacheKey(this.name, model)
    let temperature: number | undefined = unsupportedTemperatureModels.has(cacheKey)
      ? undefined
      : (options?.temperature ?? 0.7)

    for (let attempt = 0; ; attempt++) {
      let emitted = false
      try {
        const result = streamText({
          model: modelProvider,
          messages: normalized,
          allowSystemInMessages: true,
          temperature,
          maxOutputTokens: options?.maxTokens,
          timeout: 300000,
          maxRetries: 0,
          telemetry: { functionId: 'provider-stream-chat' }
        })

        let contentText = ''
        let reasoningText = ''
        let finishReason: string | null = null

        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            emitted = true
            contentText += part.text
            onEvent({ type: 'content_delta', text: part.text })
          } else if (part.type === 'reasoning-delta') {
            emitted = true
            reasoningText += part.text
            onEvent({ type: 'reasoning_delta', text: part.text })
          } else if (part.type === 'finish-step' || part.type === 'finish') {
            finishReason = part.finishReason || finishReason
          } else if (part.type === 'error') {
            throw part.error
          }
        }

        onEvent({
          type: 'message_done',
          content: contentText,
          reasoningContent: reasoningText || undefined,
          finishReason
        })
        return
      } catch (error) {
        if (attempt === 0 && !emitted && temperature !== undefined && isUnsupportedTemperatureError(error)) {
          unsupportedTemperatureModels.add(cacheKey)
          temperature = undefined
          continue
        }
        throw error
      }
    }
  }

  async testConnection(model?: string): Promise<{ success: boolean; error?: string; needsProxy?: boolean }> {
    const requestedModel = this.getRequestedModel({ model })
    const fetchImpl = resolveAiFetch(this.baseURL) || fetch
    const useResponses = this.providerKind === 'openai-responses'
    const path = this.providerKind === 'anthropic'
      ? '/messages'
      : this.providerKind === 'google'
        ? `/models/${requestedModel}:generateContent`
        : useResponses
          ? '/responses'
          : '/chat/completions'
    const url = joinEndpoint(this.baseURL, path.replace('{requestedModel}', requestedModel))
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.getDefaultHeaders() || {})
    }
    if (this.providerKind === 'anthropic') {
      headers['x-api-key'] = this.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (this.providerKind === 'google') {
      headers['x-goog-api-key'] = this.apiKey
    } else {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    const body = this.providerKind === 'anthropic'
      ? { model: requestedModel, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }
      : this.providerKind === 'google'
        ? { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }
        : useResponses
          ? { model: requestedModel, input: 'ping', max_output_tokens: 8 }
          : { model: requestedModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      } as RequestInit)
      const text = await response.text().catch(() => '')
      if (isCloudflareOrHtmlBody(text)) {
        return { success: false, error: '中转站被 Cloudflare 拦截。自定义接口应直连，不要开系统代理。可把协议改成 OpenAI Compatible 后再测。', needsProxy: false }
      }
      if (!response.ok) {
        const lower = text.toLowerCase()
        if (response.status === 401 || lower.includes('unauthorized')) {
          return { success: false, error: 'API Key 无效，请检查配置', needsProxy: false }
        }
        if (response.status === 404) {
          return { success: false, error: '接口或模型不存在。国内中转请用 OpenAI Compatible，模型名与 CC Switch 保持一致。', needsProxy: false }
        }
        return { success: false, error: `连接失败（${response.status}）：${text.slice(0, 180)}`, needsProxy: false }
      }
      return { success: true }
    } catch (error: any) {
      const message = error?.message || String(error)
      if (error?.name === 'AbortError' || /timeout|timed out|abort/i.test(message)) {
        return { success: false, error: '连接超时。自定义中转不要开系统代理，协议选 OpenAI Compatible 后再测。', needsProxy: false }
      }
      return { success: false, error: `连接失败：${message.slice(0, 180)}`, needsProxy: false }
    } finally {
      clearTimeout(timer)
    }
  }
}
