const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const root = path.join(__dirname, '..')
const pkg = require('../package.json')
process.chdir(root)
process.env.HUAJI_FAST_PACK = '1'
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}\n`)
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, env: process.env, shell: process.platform === 'win32' })
  if (result.status) process.exit(result.status)
}

run(process.execPath, ['scripts/check-wcdb-dll.cjs'])
run(process.execPath, ['scripts/update-readme-version.js'])
run(process.execPath, ['scripts/prepare-release-announcement.js'])
run(process.execPath, ['scripts/clean-dist-electron.cjs'])
run(process.execPath, [require.resolve('typescript/bin/tsc')])
run(path.join(root, 'node_modules', '.bin', 'vite'), ['build'])
run(process.execPath, ['scripts/run-electron-builder.cjs', 'win'])

const setupName = `Huaji-${pkg.version}-Setup.exe`
const setupPath = path.join(root, 'release', setupName)
if (!fs.existsSync(setupPath)) {
  console.error('missing', setupPath)
  process.exit(1)
}
const desktop = path.join(os.homedir(), 'Desktop', setupName)
fs.copyFileSync(setupPath, desktop)
const mb = (fs.statSync(setupPath).size / 1024 / 1024).toFixed(1)
console.log(`\nFast pack done: ${setupPath}`)
console.log(`Copied to desktop: ${desktop}`)
console.log(`Size: ${mb} MB (store compression, unsigned)\n`)
