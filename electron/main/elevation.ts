import { app } from 'electron'
import { execSync, spawn } from 'child_process'
import { appendFileSync } from 'fs'
import { join } from 'path'

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


/** 管理员进程默认也不开 SeDebugPrivilege，不开就读不了微信内存。必须在本进程内启用。 */
export function enableSeDebugPrivilege(): { ok: boolean; error?: string } {
  if (process.platform !== 'win32') return { ok: true }
  try {
    const koffi = require('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    const advapi32 = koffi.load('advapi32.dll')
    const GetCurrentProcess = kernel32.func('uintptr __stdcall GetCurrentProcess()')
    const OpenProcessToken = advapi32.func('bool __stdcall OpenProcessToken(uintptr ProcessHandle, uint32 DesiredAccess, _Out_ uintptr *TokenHandle)')
    const LookupPrivilegeValueW = advapi32.func('bool __stdcall LookupPrivilegeValueW(str16 lpSystemName, str16 lpName, _Out_ uint8 *lpLuid)')
    const AdjustTokenPrivileges = advapi32.func('bool __stdcall AdjustTokenPrivileges(uintptr TokenHandle, bool DisableAllPrivileges, const uint8 *NewState, uint32 BufferLength, uintptr PreviousState, uintptr ReturnLength)')
    const CloseHandle = kernel32.func('bool __stdcall CloseHandle(uintptr hObject)')
    const GetLastError = kernel32.func('uint32 __stdcall GetLastError()')

    const TOKEN_ADJUST_PRIVILEGES = 0x20
    const TOKEN_QUERY = 0x8
    const SE_PRIVILEGE_ENABLED = 0x2

    const proc = GetCurrentProcess()
    const tokenBox = [0]
    if (!OpenProcessToken(proc, TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, tokenBox)) {
      return { ok: false, error: 'OpenProcessToken ' + GetLastError() }
    }
    const token = tokenBox[0]
    const luid = Buffer.alloc(8)
    if (!LookupPrivilegeValueW(null, 'SeDebugPrivilege', luid)) {
      CloseHandle(token)
      return { ok: false, error: 'LookupPrivilegeValue ' + GetLastError() }
    }
    const tp = Buffer.alloc(16)
    tp.writeUInt32LE(1, 0)
    luid.copy(tp, 4)
    tp.writeUInt32LE(SE_PRIVILEGE_ENABLED, 12)
    const ok = AdjustTokenPrivileges(token, false, tp, tp.length, 0, 0)
    const err = GetLastError()
    CloseHandle(token)
    if (!ok || err === 1300) {
      return { ok: false, error: 'AdjustTokenPrivileges ' + err }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export function getWxKeyScanLogPath(): string {
  try {
    return join(app.getPath('userData'), 'wxkey-scan.log')
  } catch {
    return join(process.env.APPDATA || '.', 'huaji', 'wxkey-scan.log')
  }
}

export function appendWxKeyScanLog(line: string): void {
  try {
    const ts = new Date().toISOString()
    appendFileSync(getWxKeyScanLogPath(), `[${ts}] ${line}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}
