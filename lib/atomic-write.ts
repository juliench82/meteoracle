import * as fs from 'fs'
import * as path from 'path'

/**
 * Atomic JSON file writer.
 * Writes to a unique temp file in the target directory, then renameSync.
 * renameSync is atomic on POSIX filesystems (same device), preventing
 * truncated/corrupt files if the process crashes mid-write.
 *
 * Used by local-state.ts and botState.ts.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const tmp = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, filePath)
}
