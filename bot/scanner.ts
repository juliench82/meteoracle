import {
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  SCAN_INTERVAL_MS,
  logScannerTick,
  runScanner,
  writeScannerHeartbeat,
  type ScannerResult,
} from './scanner/deep-checker'
import { validateStartup } from '@/lib/startup-validation'

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
    const api = result.apiPools != null ? ` apiPools=${result.apiPools}` : ''
    console.log(
      `${label} tick done — scanned=${result.scanned} candidates=${result.candidates} ` +
      `processed=${result.processed} opened=${result.opened} ` +
      `openSkipped=${result.openSkipped}${blocked}${api}`,
    )
  } catch (err) {
    console.error(`${label} tick error:`, err)
    await logScannerTick({
      scanned: 0,
      candidates: 0,
      processed: 0,
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
    // Note: Pool cache persistence is disabled by default to avoid disk I/O on the worker.
    // The in-memory cache (with TTL) is sufficient for the current activity-based scanner.
    validateStartup(label)
      .then(() => {
        void writeScannerHeartbeat('startup')
        setInterval(() => { void writeScannerHeartbeat('interval') }, 30_000)
        return standaloneScannerTick()
      })
      .then(() => setInterval(standaloneScannerTick, SCAN_INTERVAL_MS))
      .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      })
  }
}
