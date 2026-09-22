import { defineConfig } from 'vitest/config'
import * as path from 'node:path'

// Vitest always runs from the project root, so process.cwd() is the repo root
// (where the '@/*' TS path alias points). Robust across module-system modes.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(process.cwd()),
    },
  },
  test: {
    // Explicitly ONLY tests/ — manual scripts under scripts/ (test-*.ts) must
    // never be collected as tests.
    include: ['tests/**/*.test.ts'],
  },
})