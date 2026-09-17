import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

const GITHUB_OWNER = 'huabo'
const GITHUB_REPO = 'huaji'
const GITHUB_FORCE_UPDATE_URL = ''
const R2_UPDATE_BASE_URL = ''
const GENERIC_UPDATE_URL = 'https://gitee.com/suiyingxiao/huaji/releases/download/latest'

export type ForceUpdateReason = 'minimum-version' | 'blocked-version'
export type AppUpdateSource = 'r2' | 'github' | 'custom' | 'none'
export type UpdateDownloadPhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
export type UpdateDownloadStrategy = 'unknown' | 'differential' | 'full'

export interface ForceUpdateManifest {
  schemaVersion: number
  latestVersion?: string
  minimumSupportedVersion?: string
  blockedVersions?: string[]
  title?: string
  message?: string
  releaseNotes?: string
  publishedAt?: string
}

export interface AppUpdateInfo {
  hasUpdate: boolean
  forceUpdate: boolean
  currentVersion: string
  version?: string
  releaseNotes?: string
  title?: string
  message?: string
  minimumSupportedVersion?: string
  reason?: ForceUpdateReason
  checkedAt: number
  updateSource: AppUpdateSource
  policySource: AppUpdateSource
  diagnostics?: UpdateDiagnostics
}

export interface UpdateDiagnostics {
  phase: UpdateDownloadPhase
  strategy: UpdateDownloadStrategy
  fallbackToFull: boolean
  lastError?: string
  lastEvent?: string
  progressPercent?: number
  downloadedBytes?: number
  totalBytes?: number
  targetVersion?: string
  lastUpdatedAt: number
}

type ManifestLookupResult = {
  manifest: ForceUpdateManifest | null
  source: AppUpdateSource
}

type UpdateFeedSource = 'r2' | 'github' | 'generic'

type UpdateLookupResult = {
  latestVersion?: string
  releaseNotes: string
  hasUpdate: boolean
  source: AppUpdateSource
}

function isNewerVersion(version1: string, version2: string): boolean {
  const v1Parts = version1.split('.').map(Number)
  const v2Parts = version2.split('.').map(Number)
  const maxLength = Math.max(v1Parts.length, v2Parts.length)
  while (v1Parts.length < maxLength) v1Parts.push(0)
  while (v2Parts.length < maxLength) v2Parts.push(0)

  for (let i = 0; i < maxLength; i++) {
    if (v1Parts[i] > v2Parts[i]) return true
    if (v1Parts[i] < v2Parts[i]) return false
  }

  return false
}

function isVersionEqual(version1: string, version2: string): boolean {
  return !isNewerVersion(version1, version2) && !isNewerVersion(version2, version1)
}

function normalizeReleaseNotes(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'note' in item) {
        return String((item as { note?: unknown }).note || '')
      }
      return String(item)
    }).filter(Boolean).join('\n\n')
  }
  if (value && typeof value === 'object' && 'note' in value) {
    return String((value as { note?: unknown }).note || '')
  }
  return String(value)
}

async function fetchManifestFromUrl(url: string): Promise<ForceUpdateManifest | null> {
  try {
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    })
    if (!response.ok) return null

    const data = await response.json() as ForceUpdateManifest
    if (!data || typeof data !== 'object') return null
    if (Number(data.schemaVersion || 0) < 1) return null
    return data
  } catch (error) {
    console.warn('[AppUpdate] 获取策略文件失败:', url, error)
    return null
  }
}

async function resolveForceUpdateManifest(): Promise<ManifestLookupResult> {
  const r2Url = `${R2_UPDATE_BASE_URL.replace(/\/+$/, '')}/force-update.json`
  const r2Manifest = await fetchManifestFromUrl(r2Url)
  if (r2Manifest) {
    return { manifest: r2Manifest, source: 'r2' }
  }

  const githubManifest = await fetchManifestFromUrl(GITHUB_FORCE_UPDATE_URL)
  if (githubManifest) {
    return { manifest: githubManifest, source: 'github' }
  }

  return { manifest: null, source: 'none' }
}

async function probePrivateLatestYml(baseUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/latest.yml?t=${Date.now()}`
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'text/yaml, */*' },
    })
    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: '华记私有仓库匿名访问不到 latest.yml。不是没有新版本，是更新文件没公开。' }
    }
    if (response.status === 404) {
      return { ok: false, error: '还没有 tag=latest 的 Release，或没上传 latest.yml。' }
    }
    return { ok: false, error: `检查更新失败（HTTP ${response.status}）` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function configureUpdaterFeed(source: UpdateFeedSource = 'generic'): void {
  if (source === 'github') {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO
    })
    return
  }
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: source === 'r2' && R2_UPDATE_BASE_URL ? R2_UPDATE_BASE_URL : GENERIC_UPDATE_URL
  })
}

class AppUpdateService {
  private lastInfo: AppUpdateInfo | null = null
  private diagnostics: UpdateDiagnostics = {
    phase: 'idle',
    strategy: 'unknown',
    fallbackToFull: false,
    lastUpdatedAt: Date.now()
  }

  getCachedUpdateInfo(): AppUpdateInfo | null {
    return this.lastInfo
  }

  getGenericUpdateUrl(): string {
    return GENERIC_UPDATE_URL
  }

  getR2UpdateBaseUrl(): string {
    return R2_UPDATE_BASE_URL
  }

  getGithubRepository(): { owner: string; repo: string } {
    return {
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO
    }
  }

  private buildInfo(payload: Partial<AppUpdateInfo>): AppUpdateInfo {
    return {
      hasUpdate: false,
      forceUpdate: false,
      currentVersion: app.getVersion(),
      checkedAt: Date.now(),
      updateSource: 'none',
      policySource: 'none',
      diagnostics: this.diagnostics,
      ...payload
    }
  }

  resetDiagnostics(targetVersion?: string): void {
    this.diagnostics = {
      phase: 'idle',
      strategy: 'unknown',
      fallbackToFull: false,
      targetVersion,
      lastUpdatedAt: Date.now()
    }
  }

  updateDiagnostics(patch: Partial<UpdateDiagnostics>): void {
    this.diagnostics = {
      ...this.diagnostics,
      ...patch,
      lastUpdatedAt: Date.now()
    }

    // 不再更新 lastInfo.diagnostics，因为我们已经禁用了更新功能
    // if (this.lastInfo) {
    //   this.lastInfo = {
    //     ...this.lastInfo,
    //     diagnostics: this.diagnostics
    //   }
    // }
  }

  noteUpdaterMessage(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const normalized = message.toLowerCase()
    const patch: Partial<UpdateDiagnostics> = { lastEvent: message }

    if (normalized.includes('differential')) {
      patch.strategy = 'differential'
    }

    if (
      normalized.includes('fallback to full') ||
      normalized.includes('fallback to full download') ||
      normalized.includes('cannot download differentially') ||
      normalized.includes('cannot download differentially, fallback to full download')
    ) {
      patch.strategy = 'full'
      patch.fallbackToFull = true
      patch.lastEvent = '差分更新失败，已回退到全量下载'
      if (this.diagnostics.phase === 'idle') {
        patch.phase = 'downloading'
      }
    }

    if (level === 'error') {
      patch.lastError = message
      if (this.diagnostics.phase !== 'downloaded' && this.diagnostics.phase !== 'installing') {
        patch.phase = 'failed'
      }
    }

    this.updateDiagnostics(patch)
  }

  private async checkUpdaterSource(source: UpdateFeedSource, currentVersion: string): Promise<UpdateLookupResult | null> {
    configureUpdaterFeed(source)
    const result = await autoUpdater.checkForUpdates()
    if (!result?.updateInfo?.version) {
      return null
    }

    const latestVersion = result.updateInfo.version
    const hasUpdate = isNewerVersion(latestVersion, currentVersion)
    return {
      latestVersion,
      releaseNotes: normalizeReleaseNotes(result.updateInfo.releaseNotes),
      hasUpdate,
      source: hasUpdate ? source : 'none'
    }
  }

  async checkForUpdates(): Promise<AppUpdateInfo> {
    const currentVersion = app.getVersion()
    this.resetDiagnostics()
    this.updateDiagnostics({ phase: 'checking', lastEvent: '正在检查更新' })
    const probed = await probePrivateLatestYml(GENERIC_UPDATE_URL)
    if (!probed.ok) {
      this.updateDiagnostics({ phase: 'failed', lastEvent: '私有更新源不可用', lastError: probed.error })
      const info = this.buildInfo({
        hasUpdate: false,
        forceUpdate: false,
        currentVersion,
        version: currentVersion,
        releaseNotes: '',
        updateSource: 'none',
        policySource: 'custom',
      })
      this.lastInfo = info
      return info
    }
    try {
      const lookup = await this.checkUpdaterSource('generic', currentVersion)
      const latestVersion = lookup?.latestVersion || currentVersion
      const hasUpdate = Boolean(lookup?.hasUpdate)
      this.updateDiagnostics({
        phase: hasUpdate ? 'available' : 'idle',
        lastEvent: hasUpdate ? ('发现新版本 ' + latestVersion) : '当前已是最新版本',
        targetVersion: latestVersion,
      })
      const info = this.buildInfo({
        hasUpdate,
        forceUpdate: false,
        currentVersion,
        version: latestVersion,
        releaseNotes: lookup?.releaseNotes || '',
        updateSource: hasUpdate ? 'custom' : 'none',
        policySource: 'custom',
      })
      this.lastInfo = info
      return info
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const message = /403|401/.test(raw)
        ? '华记私有仓库匿名访问不到 latest.yml。不是没有新版本，是更新文件没公开。'
        : raw
      this.updateDiagnostics({ phase: 'failed', lastEvent: '检查更新失败', lastError: message })
      const info = this.buildInfo({
        hasUpdate: false,
        forceUpdate: false,
        currentVersion,
        version: currentVersion,
        releaseNotes: '',
        updateSource: 'none',
        policySource: 'custom',
      })
      this.lastInfo = info
      return info
    }
  }

  /**
   * 开发模式专用：构造一个模拟的更新信息，用于在 dev 环境下测试更新提示 UI。
   * 不会真实检查远端版本，也不会触发下载/安装。
   */
  createSimulatedUpdateInfo(): AppUpdateInfo {
    this.resetDiagnostics('6.0.4')
    this.updateDiagnostics({
      phase: 'available',
      lastEvent: '检测到新版本 6.0.4（开发模式模拟）'
    })
    const info = this.buildInfo({
      hasUpdate: true,
      version: '6.0.4',
      releaseNotes: '开发模式模拟更新，仅用于测试更新提示 UI。',
      updateSource: 'r2',
      policySource: 'none'
    })
    // 不保存到 lastInfo
    // this.lastInfo = info
    return info
  }
}

export const appUpdateService = new AppUpdateService()
