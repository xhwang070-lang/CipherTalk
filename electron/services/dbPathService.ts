import { basename, join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'

type PathCandidate = {
  path: string
  accountCount: number
  latestModified: number
  score: number
}

export class DbPathService {
  async autoDetect(): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const candidates = this.collectCandidates()
      if (candidates.length > 0) {
        return { success: true, path: candidates[0].path }
      }

      return { success: false, error: '未能自动检测到微信数据库目录' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  hasDbStorageAccount(rootPath: string): boolean {
    try {
      if (existsSync(join(rootPath, 'db_storage'))) return true
      return this.findAccountDirs(rootPath).some((account) => existsSync(join(rootPath, account, 'db_storage')))
    } catch {
      return false
    }
  }

  isLegacyWeChatFiles(rootPath: string): boolean {
    return basename(String(rootPath || '')).toLowerCase() === 'wechat files'
  }

  describePathDecision(current?: string): string {
    const cur = String(current || '').trim()
    const weixin = this.isWeixinRunning()
    const result = this.preferLiveWeixinPath(cur)
    const candidates = this.collectCandidates().slice(0, 8).map((item) => {
      return `${item.path} score=${item.score} dbStorage=${this.hasDbStorageAccount(item.path)} accounts=${item.accountCount}`
    })
    return [
      `weixin=${weixin}`,
      `current=${cur || '-'}`,
      `currentDbStorage=${Boolean(cur && this.hasDbStorageAccount(cur))}`,
      `result=${result || '-'}`,
      `resultDbStorage=${Boolean(result && this.hasDbStorageAccount(result))}`,
      `homes=${this.windowsHomeDirs().join(',') || '-'}`,
      `candidates=${candidates.join(' || ') || 'NONE'}`,
    ].join(' ')
  }

  /** 微信 4.x（Weixin.exe）在跑时，不要用 3.x 的 WeChat Files。 */
  preferLiveWeixinPath(current?: string): string {
    const candidates = this.collectCandidates()
    const detected = candidates[0]?.path || ''
    const cur = String(current || '').trim()
    const fourX = candidates.find((item) => this.hasDbStorageAccount(item.path) && !this.isLegacyWeChatFiles(item.path))
    if (this.isWeixinRunning()) {
      if (cur && this.hasDbStorageAccount(cur) && !this.isLegacyWeChatFiles(cur)) return cur
      if (fourX) return fourX.path
      const anyDb = candidates.find((item) => this.hasDbStorageAccount(item.path))
      if (anyDb) return anyDb.path
    }
    return cur || detected
  }

  scanWxids(rootPath: string): string[] {
    try {
      if (this.isAccountDir(rootPath)) {
        return [basename(rootPath)]
      }
      return this.findAccountDirs(rootPath)
    } catch {
      return []
    }
  }

  getDefaultPath(): string {
    const home = homedir()
    const detected = this.collectCandidates()[0]
    if (detected) return detected.path

    if (process.platform === 'darwin') {
      const appSupportBase = join(
        home,
        'Library',
        'Containers',
        'com.tencent.xinWeChat',
        'Data',
        'Library',
        'Application Support',
        'com.tencent.xinWeChat'
      )

      for (const entry of this.safeReadDir(appSupportBase)) {
        if (this.isMacVersionDir(entry)) {
          return join(appSupportBase, entry)
        }
      }

      return join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files')
    }

    return join(home, 'Documents', 'xwechat_files')
  }

  private isWeixinRunning(): boolean {
    if (process.platform !== 'win32') return false
    try {
      const { execSync } = require('child_process') as typeof import('child_process')
      return execSync('tasklist /FI "IMAGENAME eq Weixin.exe" /NH', { encoding: 'utf8', windowsHide: true })
        .toLowerCase()
        .includes('weixin.exe')
    } catch {
      return false
    }
  }

  private windowsHomeDirs(): string[] {
    const homes = new Set<string>()
    for (const value of [homedir(), process.env.USERPROFILE || '', process.env.HOME || '']) {
      if (value) homes.add(value)
    }
    try {
      const execPath = process.execPath || ''
      const matched = execPath.match(/^([A-Za-z]:\\Users\\[^\\]+)/)
      if (matched) homes.add(matched[1])
    } catch { /* ignore */ }
    for (const drive of 'CDEFGHIJ') {
      for (const name of this.safeReadDir(`${drive}:\\Users`)) {
        if (name === 'Public' || name === 'Default' || name === 'Default User') continue
        homes.add(`${drive}:\\Users\\${name}`)
      }
    }
    return [...homes]
  }

  private getPossibleRoots(): string[] {
    const home = homedir()
    const possiblePaths: string[] = []

    if (process.platform === 'darwin') {
      const appSupportBase = join(
        home,
        'Library',
        'Containers',
        'com.tencent.xinWeChat',
        'Data',
        'Library',
        'Application Support',
        'com.tencent.xinWeChat'
      )

      for (const entry of this.safeReadDir(appSupportBase)) {
        if (this.isMacVersionDir(entry)) {
          possiblePaths.push(join(appSupportBase, entry))
        }
      }

      possiblePaths.push(
        join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files'),
        join(home, 'Documents', 'xwechat_files'),
        join(home, 'Documents', 'WeChat Files')
      )
      return possiblePaths
    }

    const paths: string[] = []
    const knownDocs = this.windowsKnownDocumentDir()
    if (knownDocs) {
      paths.push(join(knownDocs, 'xwechat_files'))
      paths.push(join(knownDocs, 'WeChat Files'))
    }
    for (const homeDir of this.windowsHomeDirs()) {
      for (const docs of this.windowsDocumentDirs(homeDir)) {
        paths.push(join(docs, 'xwechat_files'))
        paths.push(join(docs, 'WeChat Files'))
      }
    }
    for (const drive of 'CDEFGHIJ') {
      paths.push(`${drive}:\\xwechat_files`)
      paths.push(`${drive}:\\WeChat Files`)
    }
    return paths
  }

  private windowsDocumentDirs(homeDir: string): string[] {
    return [
      join(homeDir, 'Documents'),
      join(homeDir, '文档'),
      join(homeDir, 'OneDrive', 'Documents'),
      join(homeDir, 'OneDrive', '文档'),
    ]
  }

  private windowsKnownDocumentDir(): string {
    if (process.platform !== 'win32') return ''
    try {
      const { execSync } = require('child_process') as typeof import('child_process')
      const raw = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders" /v Personal',
        { encoding: 'utf8', windowsHide: true }
      )
      const match = raw.match(/Personal\s+REG_\w+\s+(.+)/i)
      return String(match?.[1] || '').trim()
    } catch {
      return ''
    }
  }

  private collectCandidates(): PathCandidate[] {
    const candidates: PathCandidate[] = []
    const seen = new Set<string>()

    const pushCandidate = (candidatePath: string) => {
      const normalized = String(candidatePath || '').replace(/[\\/]+$/, '')
      if (!normalized || seen.has(normalized) || !existsSync(normalized)) return
      seen.add(normalized)

      if (this.isAccountDir(normalized)) {
        const latestModified = this.getAccountModifiedTime(normalized)
        candidates.push({
          path: normalized,
          accountCount: 1,
          latestModified,
          score: 1_000_000 + latestModified
        })
        return
      }

      const accounts = this.findAccountDirs(normalized)
      if (accounts.length === 0) return

      let latestModified = 0
      let dbStorageAccounts = 0
      for (const account of accounts) {
        const accountPath = join(normalized, account)
        latestModified = Math.max(latestModified, this.getAccountModifiedTime(accountPath))
        if (existsSync(join(accountPath, 'db_storage'))) dbStorageAccounts += 1
      }

      const rootName = basename(normalized).toLowerCase()
      const weixinRunning = this.isWeixinRunning()
      const recencyDays = Math.max(0, (Date.now() - latestModified) / 86_400_000)
      const recencyScore = Math.max(0, 10_000 - recencyDays * 50)
      const typeBonus = dbStorageAccounts > 0 ? 1_000_000 : 0
      const weixinBonus = weixinRunning && dbStorageAccounts > 0 ? 500_000 : 0
      const weixinPenalty = weixinRunning && dbStorageAccounts === 0 ? -800_000 : 0
      const rootBonus =
        process.platform === 'darwin' && this.isMacVersionDir(rootName) ? 50_000 :
          rootName === 'xwechat_files' ? 100_000 :
            rootName === 'wechat files' ? 10_000 :
              0

      candidates.push({
        path: normalized,
        accountCount: accounts.length,
        latestModified,
        score: typeBonus + weixinBonus + weixinPenalty + rootBonus + accounts.length * 1_000 + recencyScore
      })
    }

    for (const candidate of this.getPossibleRoots()) {
      pushCandidate(candidate)
    }

    if (process.platform === 'darwin') {
      for (const candidate of this.getMacNestedRoots()) {
        pushCandidate(candidate)
      }
    }

    return candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.path.localeCompare(b.path)
    })
  }

  private getMacNestedRoots(): string[] {
    const home = homedir()
    const appSupportBase = join(
      home,
      'Library',
      'Containers',
      'com.tencent.xinWeChat',
      'Data',
      'Library',
      'Application Support',
      'com.tencent.xinWeChat'
    )

    const nestedRoots: string[] = []

    for (const entry of this.safeReadDir(appSupportBase)) {
      if (!this.isMacVersionDir(entry)) continue

      const versionDir = join(appSupportBase, entry)
      nestedRoots.push(versionDir)

      for (const child of this.safeReadDir(versionDir)) {
        if (!this.isPotentialAccountName(child)) continue
        nestedRoots.push(join(versionDir, child))
      }
    }

    return nestedRoots
  }

  private findAccountDirs(rootPath: string): string[] {
    const accounts: string[] = []

    try {
      for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!this.isPotentialAccountName(entry.name)) continue

        const entryPath = join(rootPath, entry.name)
        if (this.isAccountDir(entryPath)) {
          accounts.push(entry.name)
        }
      }
    } catch {
      // ignore
    }

    return accounts.sort((a, b) => {
      const aTime = this.getAccountModifiedTime(join(rootPath, a))
      const bTime = this.getAccountModifiedTime(join(rootPath, b))
      if (bTime !== aTime) return bTime - aTime
      return a.localeCompare(b)
    })
  }

  private isAccountDir(entryPath: string): boolean {
    return (
      existsSync(join(entryPath, 'db_storage')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image2')) ||
      existsSync(join(entryPath, 'msg', 'attach'))
    )
  }

  private isPotentialAccountName(name: string): boolean {
    const lower = name.toLowerCase()
    return !(
      lower.startsWith('all') ||
      lower.startsWith('applet') ||
      lower.startsWith('backup') ||
      lower.startsWith('wmpf') ||
      lower.startsWith('app_data')
    )
  }

  private isMacVersionDir(name: string): boolean {
    return /^\d+\.\d+b\d+\.\d+/.test(name) || /^\d+\.\d+\.\d+/.test(name)
  }

  private getAccountModifiedTime(entryPath: string): number {
    try {
      const accountStat = statSync(entryPath)
      let latest = accountStat.mtimeMs

      for (const candidate of [
        join(entryPath, 'db_storage'),
        join(entryPath, 'FileStorage', 'Image'),
        join(entryPath, 'FileStorage', 'Image2'),
        join(entryPath, 'msg', 'attach')
      ]) {
        if (existsSync(candidate)) {
          latest = Math.max(latest, statSync(candidate).mtimeMs)
        }
      }

      return latest
    } catch {
      return 0
    }
  }

  private safeReadDir(dirPath: string): string[] {
    try {
      if (!existsSync(dirPath)) return []
      return readdirSync(dirPath)
    } catch {
      return []
    }
  }
}

export const dbPathService = new DbPathService()
