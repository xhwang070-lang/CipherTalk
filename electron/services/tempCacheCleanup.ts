import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

const WCDB_CAP_BYTES = 8 * 1024 * 1024 * 1024
const WCDB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PDF_MAX_AGE_MS = 24 * 60 * 60 * 1000
const SKIP_RECENT_MS = 60 * 60 * 1000

export type TempCacheCleanupResult = {
  removed: number
  freedBytes: number
  notes: string[]
}

function processRunning(imageName: string): boolean {
  if (process.platform !== 'win32') return false
  const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8000,
  })
  return new RegExp(imageName.replace('.', '\\.'), 'i').test(String(result.stdout || ''))
}

function safeUnlink(filePath: string): number {
  try {
    const size = existsSync(filePath) ? statSync(filePath).size : 0
    unlinkSync(filePath)
    return size
  } catch {
    return 0
  }
}

function removeDbFamily(dbPath: string): number {
  let freed = 0
  for (const extra of ['', '-wal', '-shm']) {
    freed += safeUnlink(dbPath + extra)
  }
  freed += safeUnlink(dbPath.replace(/\.db$/i, '.sig'))
  return freed
}

function pruneWcdbCacheDir(dir: string, now: number): { removed: number; freedBytes: number } {
  if (!existsSync(dir)) return { removed: 0, freedBytes: 0 }
  const entries = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.db'))
    .map((name) => {
      const filePath = join(dir, name)
      try {
        const st = statSync(filePath)
        return { filePath, size: st.size, mtimeMs: st.mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item): item is { filePath: string; size: number; mtimeMs: number } => Boolean(item))

  let removed = 0
  let freedBytes = 0
  const kept: typeof entries = []
  for (const item of entries) {
    const age = now - item.mtimeMs
    if (age > WCDB_MAX_AGE_MS && age > SKIP_RECENT_MS) {
      freedBytes += removeDbFamily(item.filePath)
      removed += 1
    } else {
      kept.push(item)
    }
  }

  kept.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = kept.reduce((sum, item) => sum + item.size, 0)
  for (const item of kept) {
    if (total <= WCDB_CAP_BYTES) break
    if (now - item.mtimeMs < SKIP_RECENT_MS) continue
    const freed = removeDbFamily(item.filePath)
    if (!freed) continue
    freedBytes += freed
    removed += 1
    total = Math.max(0, total - item.size)
  }
  return { removed, freedBytes }
}

export function cleanupHuajiTempCaches(): TempCacheCleanupResult {
  const now = Date.now()
  const temp = tmpdir()
  const notes: string[] = []
  let removed = 0
  let freedBytes = 0

  const legacy = join(temp, 'weflow-wcdb-cache')
  if (existsSync(legacy) && !processRunning('WeFlow.exe')) {
    try {
      rmSync(legacy, { recursive: true, force: true })
      notes.push('removed leftover weflow-wcdb-cache')
      removed += 1
    } catch (error) {
      notes.push('weflow-wcdb-cache busy: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const wcdb = pruneWcdbCacheDir(join(temp, 'huaji-wcdb-cache'), now)
  removed += wcdb.removed
  freedBytes += wcdb.freedBytes
  if (wcdb.removed) notes.push('pruned huaji-wcdb-cache ' + wcdb.removed)

  try {
    for (const name of readdirSync(temp)) {
      if (!/^huaji-pdf/i.test(name)) continue
      const dir = join(temp, name)
      const before = removed
      try {
        const st = statSync(dir)
        if (!st.isDirectory()) continue
        if (now - st.mtimeMs < PDF_MAX_AGE_MS) continue
        rmSync(dir, { recursive: true, force: true })
        removed += 1
      } catch {
        // skip locked pdf temp
      }
      if (removed !== before) freedBytes += 1
    }
  } catch {
    // ignore
  }

  return { removed, freedBytes, notes }
}

export function scheduleTempCacheCleanup(log?: { info: (c: string, m: string, d?: unknown) => void; warn: (c: string, m: string, d?: unknown) => void }): void {
  const run = () => {
    try {
      const result = cleanupHuajiTempCaches()
      if (result.removed > 0 || result.notes.length > 0) {
        log?.info('TempCache', 'cleaned temp decrypt caches', result)
      }
    } catch (error) {
      log?.warn('TempCache', 'cleanup failed', { error: String(error) })
    }
  }
  setTimeout(run, 4000)
  setInterval(run, 6 * 60 * 60 * 1000).unref?.()
}
