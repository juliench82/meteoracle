import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import {
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  SCAN_INTERVAL_MS,
  logScannerTick,
  runScanner,
  writeScannerHeartbeat,
  type ScannerResult,
} from './scanner/deep-checker'

export { runScanner, type ScannerResult }

const LP_SCANNER_ENABLED = process.env.LP_SCANNER_ENABLED !== 'false' &&
  process.env.SCANNER_ENABLED !== 'false'

const standaloneScannerTick = async (): Promise<void> => {
  const label = '[lp-scanner]'
  if (!LP_SCANNER_ENABLED) {
    console.log(`${label} skipped — LP_SCANNER_ENABLED=false`)
    return
  }

  try {
    const result = await runScanner()
    const blocked = result.openBlockedReason ? ` openBlocked=${result.openBlockedReason}` : ''
    console.log(
      `${label} tick done — scanned=${result.scanned} survivors=${result.survivors} ` +
      `deepChecked=${result.deepChecked} candidates=${result.candidates} opened=${result.opened} ` +
      `openSkipped=${result.openSkipped}${blocked}`,
    )
  } catch (err) {
    console.error(`${label} tick error:`, err)
    await logScannerTick({
      scanned: 0,
      survivors: 0,
      deepChecked: 0,
      candidates: 0,
      opened: 0,
      openSkipped: 0,
      openSlots: 0,
      maxOpen: MAX_CONCURRENT_MARKET_LP_POSITIONS,
      openBlockedReason: 'unhandled_error',
      error: err instanceof Error ? err.message : String(err),
    }, 0)
  }
}

if (require.main === module || process.env.LP_SCANNER_STANDALONE === 'true') {
  const label = '[lp-scanner]'
  if (!LP_SCANNER_ENABLED) {
    console.log(`${label} disabled — LP_SCANNER_ENABLED=false`)
  } else {
    console.log(`${label} starting — poll every ${SCAN_INTERVAL_MS / 1000}s`)
    void writeScannerHeartbeat('startup')
    setInterval(() => { void writeScannerHeartbeat('interval') }, 30_000)
    standaloneScannerTick().then(() => setInterval(standaloneScannerTick, SCAN_INTERVAL_MS))
  }
}
