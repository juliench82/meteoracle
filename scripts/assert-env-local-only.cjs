const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const blocked = ['.env', '.env.production', '.env.production.local']
const found = blocked.filter(file => fs.existsSync(path.join(root, file)))

if (found.length > 0) {
  console.error(
    `[env] Refusing to start with ${found.join(', ')} present. ` +
    'Meteoracle is configured to use .env.local only; move those files aside.',
  )
  process.exit(1)
}

if (!fs.existsSync(path.join(root, '.env.local'))) {
  console.error('[env] Missing .env.local. Copy .env.local.example to .env.local and fill it in.')
  process.exit(1)
}
