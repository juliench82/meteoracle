/**
 * scripts/patch-dlmm-esm.js
 *
 * Patches @meteora-ag/dlmm/package.json after every `npm install`.
 *
 * ROOT CAUSE:
 *   @meteora-ag/dlmm ships both dist/index.mjs (ESM) and dist/index.js (CJS).
 *   When Node.js resolves `import '@meteora-ag/dlmm'` (which tsx emits for every
 *   TypeScript `import` statement), it picks the `import` condition → dist/index.mjs.
 *   That .mjs file internally does `import { BN } from '@coral-xyz/anchor'`.
 *   Anchor's ESM bundle does NOT re-export BN, so Node throws:
 *     SyntaxError: The requested module '@coral-xyz/anchor' does not
 *     provide an export named 'BN'
 *   The stack trace source-maps back to src/dlmm/constants/index.ts:2,
 *   which misleadingly looks like tsx is loading TypeScript source — it is not.
 *
 * FIX:
 *   Rewrite the DLMM package exports so every condition (import, require, default)
 *   points to the CJS dist (dist/index.js). CJS loads @coral-xyz/anchor via
 *   require(), which DOES expose BN correctly.
 *   Also removes the top-level `source` field to prevent any bundler from
 *   inadvertently loading the TypeScript source.
 */

const fs = require('fs')
const path = require('path')

const pkgPath = path.resolve(__dirname, '../node_modules/@meteora-ag/dlmm/package.json')

try {
  const raw = fs.readFileSync(pkgPath, 'utf8')
  const pkg = JSON.parse(raw)

  let changed = false

  // Patch exports: point import + default → CJS dist
  if (pkg.exports?.['.']) {
    pkg.exports['.'] = {
      types:   './dist/index.d.ts',
      require: './dist/index.js',
      import:  './dist/index.js', // was dist/index.mjs — that one fails with anchor BN
      default: './dist/index.js',
    }
    changed = true
  }

  // Remove top-level `source` field (prevents bundlers loading TS source)
  if (pkg.source) {
    delete pkg.source
    changed = true
  }

  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    console.log('[patch-dlmm-esm] Patched @meteora-ag/dlmm — all conditions now use CJS dist')
  } else {
    console.log('[patch-dlmm-esm] @meteora-ag/dlmm already patched, nothing to do')
  }
} catch (err) {
  // Non-fatal: warn but don't fail the install
  console.warn('[patch-dlmm-esm] Could not patch @meteora-ag/dlmm:', err.message)
}
