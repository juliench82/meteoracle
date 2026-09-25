#!/usr/bin/env node
/**
 * scripts/test-local-state-writequeue-recovery.cjs
 *
 * Manual reproduction harness for audit finding H2 ("one transient disk error
 * poisons the write queue"). It replays the audit's own experiment — this time
 * against the BUILT artifacts in dist/ — so a reviewer can re-run it after
 * `npm run build` without touching the source-based vitest suite.
 *
 * Usage:
 *   npm run build
 *   node scripts/test-local-state-writequeue-recovery.cjs
 *
 * Exit code 0 = the queue recovered (mutator ran on the retry, no data lost).
 * Exit code 1 = the poisoned-queue regression is present.
 *
 * Hermetic: works in an os.tmpdir() directory, injects one synthetic ENOSPC via
 * fs.renameSync, sends no alert (a single injected failure never reaches the
 * 3-strike pause), no network, no wallet, no .env.local.
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-h2-dist-'))
process.chdir(workDir) // dist/lib/local-state.js resolves state/ from cwd

// Patch fs BEFORE requiring dist: the compiled modules copy fs properties at load.
let failuresLeft = 1
const realRenameSync = fs.renameSync
fs.renameSync = function patchedRenameSync(...args) {
  if (failuresLeft > 0) {
    failuresLeft--
    const err = new Error('ENOSPC: no space left on device (injected)')
    err.code = 'ENOSPC'
    throw err
  }
  return realRenameSync.apply(fs, args)
}

const state = require(path.join(__dirname, '..', 'dist', 'lib', 'local-state.js'))

const stateFile = path.join(workDir, 'state', 'open-lp-positions.json')
const read = () =>
  fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : []

function cleanup() {
  try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
}

async function main() {
  const lines = []

  // 1) transient failure
  try {
    await state.withQueuedUpdate((ps) => { ps.push({ id: 'D' }) })
    lines.push('1) write failed (transient)      -> UNEXPECTED: succeeded')
  } catch (e) {
    lines.push(`1) write failed (transient)      -> threw: ${e.code || e.message}`)
  }

  // 2) retry on a HEALTHY disk — the mutator must run
  let mutatorRanOnRetry = false
  try {
    await state.withQueuedUpdate((ps) => { mutatorRanOnRetry = true; ps.push({ id: 'D' }) })
  } catch (e) {
    lines.push(`2) retry on HEALTHY disk         -> threw again: ${e.code || e.message}`)
  }
  lines.push(`   mutator ran on retry? ${mutatorRanOnRetry} | file: ${JSON.stringify(read())}`)

  // 3) saveOpenLpPositions returns a promise and no longer swallows
  const savePromise = state.saveOpenLpPositions(read())
  lines.push(`3) saveOpenLpPositions()         -> promise returned? ${savePromise instanceof Promise}`)
  try {
    await savePromise
    lines.push(`   resolved on healthy disk     | file: ${JSON.stringify(read())}`)
  } catch (e) {
    lines.push(`   rejected: ${e.code || e.message}`)
  }

  // 4) the queue is still healthy for later writes
  let mutatorRanAfter = false
  await state.withQueuedUpdate((ps) => { mutatorRanAfter = true; ps[0].symbol = 'UPDATED' })
  lines.push(`4) subsequent update             -> mutator ran? ${mutatorRanAfter} | file: ${JSON.stringify(read())}`)

  console.log(lines.join('\n'))

  const recovered =
    mutatorRanOnRetry === true &&
    mutatorRanAfter === true &&
    read().length === 1 &&
    read()[0].id === 'D' &&
    read()[0].symbol === 'UPDATED'

  console.log(`\nRESULT: ${recovered ? 'queue recovered — no write lost (H2 fixed)' : 'QUEUE STILL POISONED (H2 present)'}`)
  return recovered
}

main()
  .then((ok) => { cleanup(); process.exit(ok ? 0 : 1) })
  .catch((err) => { console.error(err); cleanup(); process.exit(1) })