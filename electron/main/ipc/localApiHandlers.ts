import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { generateLocalApiToken, localApiService } from '../../services/localApiService'

function applyFromConfig(ctx: MainProcessContext): string {
  const config = ctx.getConfigService()
  let token = String(config?.get('localApiToken') || '').trim()
  if (!token) {
    token = generateLocalApiToken()
    config?.set('localApiToken', token)
  }
  const port = Number(config?.get('localApiPort') || 5034)
  localApiService.applySettings(port, token)
  return token
}

export async function startLocalApiIfEnabled(ctx: MainProcessContext): Promise<void> {
  const config = ctx.getConfigService()
  if (!config?.get('localApiEnabled')) return
  applyFromConfig(ctx)
  const result = await localApiService.start()
  if (!result.success) {
    ctx.getLogService()?.warn('LocalApi', '本地 API 启动失败', { error: result.error })
  }
}

export function registerLocalApiHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('localApi:getStatus', async () => {
    applyFromConfig(ctx)
    return {
      ...localApiService.getStatus(),
      enabled: Boolean(ctx.getConfigService()?.get('localApiEnabled')),
      token: String(ctx.getConfigService()?.get('localApiToken') || '')
    }
  })

  ipcMain.handle('localApi:setEnabled', async (_, enabled: boolean) => {
    const config = ctx.getConfigService()
    config?.set('localApiEnabled', Boolean(enabled))
    applyFromConfig(ctx)
    if (enabled) {
      const result = await localApiService.start()
      return { ...result, status: { ...localApiService.getStatus(), enabled: true, token: String(config?.get('localApiToken') || '') } }
    }
    await localApiService.stop()
    return { success: true, status: { ...localApiService.getStatus(), enabled: false, token: String(config?.get('localApiToken') || '') } }
  })

  ipcMain.handle('localApi:setPort', async (_, port: number) => {
    const config = ctx.getConfigService()
    const next = Math.max(1024, Math.min(65535, Math.floor(Number(port) || 5034)))
    config?.set('localApiPort', next)
    const wasRunning = localApiService.isRunning()
    if (wasRunning) await localApiService.stop()
    applyFromConfig(ctx)
    if (wasRunning || config?.get('localApiEnabled')) {
      const result = await localApiService.start()
      return { ...result, status: { ...localApiService.getStatus(), enabled: Boolean(config?.get('localApiEnabled')), token: String(config?.get('localApiToken') || '') } }
    }
    return { success: true, status: { ...localApiService.getStatus(), enabled: Boolean(config?.get('localApiEnabled')), token: String(config?.get('localApiToken') || '') } }
  })

  ipcMain.handle('localApi:rotateToken', async () => {
    const config = ctx.getConfigService()
    const token = generateLocalApiToken()
    config?.set('localApiToken', token)
    const wasRunning = localApiService.isRunning()
    if (wasRunning) await localApiService.stop()
    applyFromConfig(ctx)
    if (wasRunning || config?.get('localApiEnabled')) {
      await localApiService.start()
    }
    return { success: true, token, status: { ...localApiService.getStatus(), enabled: Boolean(config?.get('localApiEnabled')), token } }
  })
}
