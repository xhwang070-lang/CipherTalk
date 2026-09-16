const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const pkg = require('../package.json')

const releaseDir = path.join(__dirname, '..', 'release')
const inputTarget = process.argv[2]

const targetMap = {
  win: {
    artifactName: `Huaji-${pkg.version}-Setup.exe`,
    manifestName: 'latest.yml'
  },
  mac: {
    artifactName: `Huaji-${pkg.version}-Setup.dmg`,
    manifestName: 'latest-mac.yml'
  }
}

function toSha512Base64(filePath) {
  const fileBuffer = fs.readFileSync(filePath)
  return crypto.createHash('sha512').update(fileBuffer).digest('base64')
}

function formatManifest({ version, artifactName, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${artifactName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${artifactName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n')
}

function generateManifest(target) {
  const { artifactName, manifestName } = targetMap[target]
  const artifactPath = path.join(releaseDir, artifactName)

  if (!fs.existsSync(artifactPath)) {
    return false
  }

  const sha512 = toSha512Base64(artifactPath)
  const size = fs.statSync(artifactPath).size
  const releaseDate = new Date().toISOString()
  const content = formatManifest({
    version: pkg.version,
    artifactName,
    sha512,
    size,
    releaseDate
  })

  fs.writeFileSync(path.join(releaseDir, manifestName), content, 'utf8')
  const notes = [
    '华记私有更新（不要传到密语官方）',
    '',
    '1. 在 Gitee 仓库 suiyingxiao/huaji 建或更新一个 Release，Tag 固定写成 latest（每次覆盖）。',
    '2. 上传这两个文件：',
    `   - ${manifestName}`,
    `   - ${artifactName}`,
    '3. 客户端会请求：',
    '   https://gitee.com/suiyingxiao/huaji/releases/download/latest/' + manifestName,
    '',
    '如果安装包超过 Gitee 附件限制：把 exe 放到你们自己的网站目录，',
    '再把 latest.yml 里的 url / path 改成完整下载地址，yml 仍放在上面这个 latest 目录。',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(releaseDir, '如何上传更新.txt'), notes, 'utf8')
  console.log(`✅ ${manifestName} 已生成`)
  return true
}

if (inputTarget) {
  if (!targetMap[inputTarget]) {
    console.error('Usage: node scripts/generate-update-manifest.js [win|mac]')
    process.exit(1)
  }

  if (!generateManifest(inputTarget)) {
    console.error(`Artifact not found for target: ${inputTarget}`)
    process.exit(1)
  }
  process.exit(0)
}

const generatedCount = Object.keys(targetMap).filter(generateManifest).length
if (generatedCount === 0) {
  console.error('No supported artifacts found in release directory')
  process.exit(1)
}
