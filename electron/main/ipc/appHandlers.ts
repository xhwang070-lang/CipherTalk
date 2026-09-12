import { app, ipcMain } from 'electron'
import { isProcessElevated, relaunchProcessElevated } from '../elevation'
import { appUpdateService } from '../../services/appUpdateService'
import { getMcpLaunchConfig as getMcpLaunchConfigForUi } from '../../services/mcp/runtime'
import { getRuntimePlatformInfo } from '../../services/platformService'
import type { MainProcessContext } from '../context'

export function registerAppHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('app:getDownloadsPath', async () => {
    return app.getPath('downloads')
  })

  ipcMain.handle('app:getVersion', async () => {
    return app.getVersion()
  })

  ipcMain.handle('app:getPlatformInfo', async () => {
    return getRuntimePlatformInfo()
  })

  ipcMain.handle('app:isElevated', async () => {
    return isProcessElevated()
  })

  ipcMain.handle('app:relaunchElevated', async () => {
    return relaunchProcessElevated()
  })


  ipcMain.handle('app:getMcpLaunchConfig', async () => {
    return getMcpLaunchConfigForUi()
  })

  ipcMain.on('app:getMcpLaunchConfig:request', (event, payload: { requestId?: string } | undefined) => {
    const requestId = payload?.requestId
    if (!requestId) return
    event.sender.send(`app:getMcpLaunchConfig:response:${requestId}`, getMcpLaunchConfigForUi())
  })

  ipcMain.handle('app:checkForUpdates', async () => {
    console.log('[IPC Debug] app:checkForUpdates 被调用')
    console.trace('[IPC Debug] 调用堆栈:')
    return appUpdateService.checkForUpdates()
  })

  ipcMain.handle('app:getUpdateState', async () => {
    console.log('[IPC Debug] app:getUpdateState 被调用')
    console.trace('[IPC Debug] 调用堆栈:')
    const result = appUpdateService.getCachedUpdateInfo()
    console.log('[IPC Debug] app:getUpdateState 返回值:', result)
    return result
  })

  ipcMain.handle('app:getUpdateSourceInfo', async () => {
    return {
      primaryUpdateSource: 'r2' as const,
      r2UpdateBaseUrl: appUpdateService.getR2UpdateBaseUrl(),
      githubRepository: appUpdateService.getGithubRepository(),
      policySources: ['r2', 'github'] as const,
      policyPrecedence: 'r2' as const
    }
  })

  ipcMain.handle('app:getStartupDbConnected', () => {
    const connected = ctx.getStartupDbConnected()
    ctx.setStartupDbConnected(false)
    return connected
  })
}
