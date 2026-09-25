/**
 * lib/backup.ts
 *
 * Thin off-host snapshot of state/ only (G5). Read-only on state/ — it NEVER
 * writes into state/, so it cannot interfere with the atomic writes in
 * lib/atomic-write.ts or the serialized write queue in lib/local-state.ts.
 *
 * Two targets, chosen by env:
 *   - STATE_BACKUP_TARGET    : a local directory; `state/*` is copied in via fs.
 *   - STATE_BACKUP_S3_PREFIX  : an `s3://bucket/prefix` (or similar); backed up
 *                              via `aws s3 sync state/ <prefix>/` (no S3 SDK).
 * With neither configured the whole thing is a dry-safe no-op (returns true).
 *
 * STATE_DIR mirrors lib/local-state.ts. It is intentionally duplicated here
 * rather than imported, so this module stays free of heavier deps (alerter, on
 * -chain libs) and is hermetically testable.
 */
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

const STATE_DIR = path.join(process.cwd(), 'state')

function isDryRun(): boolean {
  return process.env.BOT_DRY_RUN === 'true'
}

function hasTarget(): boolean {
  return !!(process.env.STATE_BACKUP_TARGET || process.env.STATE_BACKUP_S3_PREFIX)
}

/**
 * Snapshot state/* to the configured off-host target.
 * Returns true on success or when there is nothing configured / nothing to back
 * up. Never throws into the caller.
 */
export async function backupState(): Promise<boolean> {
  if (isDryRun() || !hasTarget()) return true

  if (!fs.existsSync(STATE_DIR)) return true // nothing to back up

  try {
    const target = process.env.STATE_BACKUP_TARGET
    const s3Prefix = process.env.STATE_BACKUP_S3_PREFIX

    if (target) {
      fs.mkdirSync(target, { recursive: true })
      const entries = fs.readdirSync(STATE_DIR)
      for (const entry of entries) {
        const src = path.join(STATE_DIR, entry)
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(target, entry))
        }
      }
      return true
    }

    if (s3Prefix) {
      // No S3 SDK dependency — shell out to the aws CLI (thin slice).
      execSync(`aws s3 sync ${STATE_DIR}/ ${s3Prefix}/`, { stdio: 'pipe' })
      return true
    }

    return true
  } catch (e) {
    console.warn('[backup] state backup failed:', e)
    return false
  }
}

/**
 * Periodic trigger for backupState(). Guarded so dry-run / unconfigured
 * deployments never start an interval. Returns a { stop } handle (a no-op
 * stop() when the guard refused to start).
 */
export function startStateBackupTimer(intervalMs: number): { stop: () => void } {
  if (isDryRun() || !hasTarget()) {
    return { stop: () => {} }
  }

  const handle = setInterval(() => {
    backupState().catch((e) => console.warn('[backup] backupState error:', e))
  }, intervalMs)

  return { stop: () => clearInterval(handle) }
}
