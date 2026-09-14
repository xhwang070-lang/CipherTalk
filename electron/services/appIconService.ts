import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { nativeImage } from 'electron'
import { getUserDataPath } from './runtimePaths'

const CUSTOM_APP_ICON_FILE = 'custom-app-icon.png'
const MAX_ICON_BYTES = 8 * 1024 * 1024

export function getCustomAppIconPath(): string {
  return join(getUserDataPath(), CUSTOM_APP_ICON_FILE)
}

export function hasCustomAppIcon(): boolean {
  return existsSync(getCustomAppIconPath())
}

export function getCustomAppIconPreview(): string | null {
  const file = getCustomAppIconPath()
  if (!existsSync(file)) return null
  return 'data:image/png;base64,' + readFileSync(file).toString('base64')
}

export function saveCustomAppIcon(sourcePath: string): { success: boolean; error?: string } {
  const source = String(sourcePath || '').trim()
  if (!source || !existsSync(source)) return { success: false, error: '文件不存在' }
  const size = statSync(source).size
  if (size <= 0 || size > MAX_ICON_BYTES) return { success: false, error: '图标太大，请换一张 8MB 以内的' }
  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) return { success: false, error: '读不了这个图标，换 png 或 ico 试试' }
  const png = image.toPNG()
  if (!png.length) return { success: false, error: '图标转换失败' }
  const dest = getCustomAppIconPath()
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, png)
  return { success: true }
}

export function clearCustomAppIcon(): void {
  const file = getCustomAppIconPath()
  if (existsSync(file)) unlinkSync(file)
}

export function getAppIconState(): { custom: boolean; previewUrl: string | null } {
  return {
    custom: hasCustomAppIcon(),
    previewUrl: getCustomAppIconPreview(),
  }
}
