/**
 * 导出/导入华记配置：待办、模型预设、看图模型。不含解密密钥、微信 token、all_keys。
 */
import { importHuajiTodos, listHuajiTodos, type HuajiTodoItem } from './agent/huajiTodos'
import { ConfigService } from './config'

export type HuajiBackupBundle = {
  version: 1
  exportedAt: string
  todos: HuajiTodoItem[]
  settings: {
    aiCurrentProvider: string
    aiVisionModel: string
    morningTodoPushEnabled: boolean
    morningTodoPushHour: number
    aiProviderConfigs: Record<string, { model?: string; baseURL?: string; protocol?: string }>
    imageGenConfig: { enabled?: boolean; protocol?: string; baseURL?: string; model?: string; size?: string; timeoutMs?: number }
  }
}

function stripProviderConfigs(raw: unknown): HuajiBackupBundle['settings']['aiProviderConfigs'] {
  const out: HuajiBackupBundle['settings']['aiProviderConfigs'] = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, value] of Object.entries(raw as Record<string, any>)) {
    if (!value || typeof value !== 'object') continue
    out[id] = {
      model: typeof value.model === 'string' ? value.model : undefined,
      baseURL: typeof value.baseURL === 'string' ? value.baseURL : undefined,
      protocol: typeof value.protocol === 'string' ? value.protocol : undefined,
    }
  }
  return out
}

export function exportHuajiBackup(): HuajiBackupBundle {
  const config = new ConfigService()
  try {
    const imageGen = config.get('imageGenConfig') || { enabled: false, protocol: 'openai-compatible', apiKey: '', baseURL: '', model: '', size: '', timeoutMs: 0 }
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      todos: listHuajiTodos('all'),
      settings: {
        aiCurrentProvider: String(config.get('aiCurrentProvider') || ''),
        aiVisionModel: String(config.get('aiVisionModel') || ''),
        morningTodoPushEnabled: config.get('morningTodoPushEnabled') !== false,
        morningTodoPushHour: Number(config.get('morningTodoPushHour') || 8),
        aiProviderConfigs: stripProviderConfigs(config.get('aiProviderConfigs')),
        imageGenConfig: {
          enabled: Boolean(imageGen.enabled),
          protocol: imageGen.protocol,
          baseURL: imageGen.baseURL,
          model: imageGen.model,
          size: imageGen.size,
          timeoutMs: imageGen.timeoutMs,
        },
      },
    }
  } finally {
    config.close()
  }
}

export function importHuajiBackup(bundle: HuajiBackupBundle): { importedTodos: number; settings: boolean } {
  if (!bundle || bundle.version !== 1) throw new Error('不是华记配置包')
  const importedTodos = importHuajiTodos(bundle.todos || [])
    const config = new ConfigService()
  try {
    const settings = bundle.settings || ({} as HuajiBackupBundle['settings'])
    if (settings.aiCurrentProvider) config.set('aiCurrentProvider', settings.aiCurrentProvider)
    if (typeof settings.aiVisionModel === 'string') config.set('aiVisionModel', settings.aiVisionModel)
    if (typeof settings.morningTodoPushEnabled === 'boolean') config.set('morningTodoPushEnabled', settings.morningTodoPushEnabled)
    if (Number.isFinite(settings.morningTodoPushHour)) config.set('morningTodoPushHour', Math.max(0, Math.min(23, Number(settings.morningTodoPushHour))))
    if (settings.aiProviderConfigs && typeof settings.aiProviderConfigs === 'object') {
      const current = { ...(config.get('aiProviderConfigs') || {}) } as Record<string, any>
      for (const [id, patch] of Object.entries(settings.aiProviderConfigs)) {
        const prev = current[id] || { apiKey: '', model: '', baseURL: '' }
        current[id] = {
          ...prev,
          model: patch.model || prev.model,
          baseURL: patch.baseURL || prev.baseURL,
          protocol: patch.protocol || prev.protocol,
        }
      }
      config.set('aiProviderConfigs', current as any)
    }
    if (settings.imageGenConfig) {
      const prev = config.get('imageGenConfig')
      config.set('imageGenConfig', {
        ...prev,
        enabled: settings.imageGenConfig.enabled ?? prev.enabled,
        protocol: (settings.imageGenConfig.protocol as any) || prev.protocol,
        baseURL: settings.imageGenConfig.baseURL || prev.baseURL,
        model: settings.imageGenConfig.model || prev.model,
        size: settings.imageGenConfig.size ?? prev.size,
        timeoutMs: settings.imageGenConfig.timeoutMs || prev.timeoutMs,
      })
    }
  } finally {
    config.close()
  }
  return { importedTodos, settings: true }
}
