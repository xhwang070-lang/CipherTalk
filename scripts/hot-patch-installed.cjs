/**
 * Local hot patch for the already-installed Huaji.
 * Rebuilds JS (tsc + vite) and copies dist / dist-electron into the installed app.
 * First run unpacks app.asar once (~200MB). Later runs are copy + restart, no NSIS.
 *
 *   npm run pack:hot              patch installed Huaji and restart
 *   npm run pack:hot -- --unpacked   patch release/win-unpacked instead
 *   npm run pack:hot -- --no-build   skip tsc/vite, only copy
 *   npm run pack:hot -- --no-restart
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const asar = require('@electron/asar')

const root = path.join(__dirname, '..')
const pkg = require('../package.json')
process.chdir(root)

const args = new Set(process.argv.slice(2))
const skipBuild = args.has('--no-build')
const skipRestart = args.has('--no-restart')
const useUnpacked = args.has('--unpacked')

function run(cmd, cmdArgs) {
  console.log(`\n> ${cmd} ${cmdArgs.join(' ')}\n`)
  const result = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
    shell: process.platform === 'win32',
  })
  if (result.status) process.exit(result.status)
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function resolveInstall() {
  if (useUnpacked) {
    const unpacked = path.join(root, 'release', 'win-unpacked', 'Huaji.exe')
    if (!fs.existsSync(unpacked)) {
      console.error('missing release/win-unpacked/Huaji.exe, pack:win first')
      process.exit(1)
    }
    return unpacked
  }
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Huaji', 'Huaji.exe'),
    path.join(process.env.ProgramFiles || '', 'Huaji', 'Huaji.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Huaji', 'Huaji.exe'),
  ]
  const found = candidates.find((item) => fs.existsSync(item))
  if (!found) {
    console.error('installed Huaji.exe not found. Install a Setup.exe once, then pack:hot.')
    process.exit(1)
  }
  return found
}

function stopHuaji() {
  console.log('stopping Huaji.exe ...')
  spawnSync('taskkill', ['/IM', 'Huaji.exe', '/F'], { stdio: 'ignore', windowsHide: true })
  spawnSync('taskkill', ['/IM', 'electron.exe', '/F'], { stdio: 'ignore', windowsHide: true })
  for (let i = 0; i < 15; i += 1) {
    const check = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Huaji.exe'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const out = String(check.stdout || '')
    if (!/Huaji\.exe/i.test(out)) return
    sleep(400)
  }
  console.warn('Huaji.exe still running; asar copy may fail if the file is locked')
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true, force: true })
}

function ensureUnpackedApp(resourcesDir) {
  const appDir = path.join(resourcesDir, 'app')
  const asarPath = path.join(resourcesDir, 'app.asar')
  const bakPath = path.join(resourcesDir, 'app.asar.bak')

  if (!fs.existsSync(appDir)) {
    if (!fs.existsSync(asarPath) && !fs.existsSync(bakPath)) {
      console.error('no app.asar in', resourcesDir)
      process.exit(1)
    }
    const source = fs.existsSync(asarPath) ? asarPath : bakPath
    console.log('first hot patch: extracting app.asar (once, ~200MB) ...')
    asar.extractAll(source, appDir)
  }

  if (fs.existsSync(asarPath)) {
    if (!fs.existsSync(bakPath)) {
      fs.renameSync(asarPath, bakPath)
    } else {
      fs.rmSync(asarPath, { force: true })
    }
  }
  return appDir
}

const exePath = resolveInstall()
const installDir = path.dirname(exePath)
const resourcesDir = path.join(installDir, 'resources')
if (!fs.existsSync(resourcesDir)) {
  console.error('missing resources dir', resourcesDir)
  process.exit(1)
}

console.log(`hot patch target: ${exePath}`)
console.log(`version: ${pkg.version}`)

stopHuaji()

if (!skipBuild) {
  run(process.execPath, ['scripts/check-wcdb-dll.cjs'])
  run(process.execPath, ['scripts/clean-dist-electron.cjs'])
  run(process.execPath, [require.resolve('typescript/bin/tsc')])
  run(path.join(root, 'node_modules', '.bin', 'vite'), ['build'])
}

const dist = path.join(root, 'dist')
const distElectron = path.join(root, 'dist-electron')
if (!fs.existsSync(dist) || !fs.existsSync(distElectron)) {
  console.error('missing dist or dist-electron, build failed')
  process.exit(1)
}

const appDir = ensureUnpackedApp(resourcesDir)
console.log('copying dist + dist-electron + package.json ...')
fs.rmSync(path.join(appDir, 'dist'), { recursive: true, force: true })
fs.rmSync(path.join(appDir, 'dist-electron'), { recursive: true, force: true })
copyDir(dist, path.join(appDir, 'dist'))
copyDir(distElectron, path.join(appDir, 'dist-electron'))
fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'package.json'))

if (!skipRestart) {
  console.log('starting Huaji ...')
  spawnSync('cmd', ['/c', 'start', '', exePath], { cwd: installDir, windowsHide: true })
}

console.log(`\nHot patch done: ${installDir}`)
console.log('JS-only changes. Native DLL / installer identity still need pack:win.\n')