import { createRequire } from 'module'
const require = createRequire(import.meta.url)
require('dotenv').config({ path: '.env.local' })
import('./bot/scanner.ts').then(m => m.runScanner()).then(console.log).catch(console.error)
