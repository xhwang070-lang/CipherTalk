const fs = require('fs')
const path = require('path')

const dllPath = path.join(__dirname, '..', 'resources', 'wcdb_api.dll')
const OFFICIAL_SIZE = 324096
const MIN_HUAJI_SIZE = 1_000_000

if (!fs.existsSync(dllPath)) {
  console.error('[check-wcdb-dll] missing resources/wcdb_api.dll')
  process.exit(1)
}

const size = fs.statSync(dllPath).size
if (size === OFFICIAL_SIZE || size < MIN_HUAJI_SIZE) {
  console.error(`[check-wcdb-dll] refusing to pack official/small wcdb_api.dll (${size} bytes)`)
  process.exit(1)
}

console.log(`[check-wcdb-dll] ok ${path.basename(dllPath)} ${size} bytes`)
