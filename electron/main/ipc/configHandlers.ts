import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { chatService } from '../../services/chatService'
import { clearMessageDbScannerCache } from '../../services/messageDbScanner'
import { ConfigService } from '../../services/config'

function clearStatsCaches(): void {
  clearMessageDbScannerCache()
  chatService.close()
}


function resolveConfigService(ctx: MainProcessContext) {
  const existing = ctx.getConfigService()
  if (existing) return { service: existing, ephemeral: false }
  return { service: new ConfigService(), ephemeral: true }
}

export function registerConfigHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('config:get', async (_, key: string) => {
    const { service, ephemeral } = resolveConfigService(ctx)
    try {
      return service.get(key as any)
    } finally {
      if (ephemeral) service.close()
    }
  })

  ipcMain.handle('config:set', async (_, key: string, value: any) => {
    const { service, ephemeral } = resolveConfigService(ctx)
    let result
    try {
      result = service.set(key as any, value)
    } finally {
      if (ephemeral) service.close()
    }
    ctx.broadcastToWindows('config:changed', { key, value })
    if (['myWxid', 'dbPath', 'decryptKey'].includes(key)) clearStatsCaches()
    return result
  })

  ipcMain.handle('config:getTldCache', async () => {
    return ctx.getConfigService()?.getTldCache()
  })

  ipcMain.handle('config:setTldCache', async (_, tlds: string[]) => {
    return ctx.getConfigService()?.setTldCache(tlds)
  })

  ipcMain.handle('config:exportHuajiBackup', async () => {
    try {
      const { exportHuajiBackup } = await import('../../services/huajiBackup')
      return { success: true, bundle: exportHuajiBackup() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('config:importHuajiBackup', async (_event, bundle: unknown) => {
    try {
      const { importHuajiBackup } = await import('../../services/huajiBackup')
      return { success: true, result: importHuajiBackup(bundle as any) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
