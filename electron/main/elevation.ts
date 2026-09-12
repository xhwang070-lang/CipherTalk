import { app } from 'electron'
import { execSync, spawn } from 'child_process'

export function isProcessElevated(): boolean {
  if (process.platform !== 'win32') return true
  try {
    execSync('net session', { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * 提权再拉起华记。必须先放开单实例锁，否则管理员进程会看到旧窗口并立刻退出，
 * 界面上就像「右键管理员 / 点重启」没反应，UAC 也可能被瞬间关掉。
 */
export function relaunchProcessElevated(): { success: boolean; already?: boolean; error?: string } {
  if (process.platform !== 'win32') {
    return { success: false, error: '仅 Windows 需要提权' }
  }
  if (isProcessElevated()) {
    return { success: true, already: true }
  }
  const exe = process.execPath.replace(/'/g, "''")
  const extraArgs = app.isPackaged
    ? ''
    : ` -ArgumentList @(${process.argv.slice(1).map((a) => "'" + a.replace(/'/g, "''") + "'").join(',')})`
  const ps = `Start-Process -FilePath '${exe}' -Verb RunAs${extraArgs}`
  try {
    app.releaseSingleInstanceLock()
  } catch {
    /* ignore */
  }
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref()
  app.quit()
  return { success: true }
}
