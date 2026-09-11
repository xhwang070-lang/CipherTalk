import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { getDocumentsPath, getExePath, getUserDataPath } from './runtimePaths'

export interface RuntimePlatformInfo {
  platform: NodeJS.Platform
  arch: string
}

export interface CachePathResult {
  success: boolean
  path: string
  drive: string
}

export function getRuntimePlatformInfo(): RuntimePlatformInfo {
  return {
    platform: process.platform,
    arch: process.arch
  }
}

export function getDefaultCachePath(): string {
  const documentsPath = getDocumentsPath()

  if (process.platform === 'darwin') {
    return join(documentsPath, 'HuajiData')
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    return join(documentsPath, 'HuajiData')
  }

  const exePath = getExePath()
  const installDir = dirname(exePath)
  const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\\\')

  if (process.platform === 'win32') {
    if (isOnCDrive) {
      return join(documentsPath, 'HuajiData')
    }
    return join(installDir, 'HuajiData')
  }

  return join(getUserDataPath(), 'HuajiData')
}

export function getBestCachePath(): CachePathResult {
  if (process.platform !== 'win32') {
    return {
      success: true,
      path: getDefaultCachePath(),
      drive: 'default'
    }
  }

  const systemDrive = (process.env.SystemDrive || 'C:').replace(':', '').toUpperCase()
  const allDrives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const candidates = [
    ...allDrives.filter(d => d !== systemDrive),
    systemDrive,
  ]

  for (const drive of candidates) {
    if (existsSync(`${drive}:\\`)) {
      return {
        success: true,
        path: join(`${drive}:\\`, 'HuajiDB'),
        drive
      }
    }
  }

  return {
    success: true,
    path: getDefaultCachePath(),
    drive: 'default'
  }
}
