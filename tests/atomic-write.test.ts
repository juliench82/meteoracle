/**
 * Hermetic tests for the atomic JSON writer (lib/atomic-write.ts).
 *
 * Uses a temp dir under os.tmpdir() — never touches the repo, never the
 * developer's state/, no network, no env.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { atomicWriteJson } from '@/lib/atomic-write'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-atomic-'))
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    out.push(String(entry))
  }
  return out
}

describe('atomicWriteJson', () => {
  it('creates missing directories and writes parseable JSON', () => {
    const tmp = makeTempDir()
    try {
      const target = path.join(tmp, 'nested', 'dir', 'file.json')
      atomicWriteJson(target, { hello: 'world', n: 42 })
      expect(fs.existsSync(target)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
      expect(parsed).toEqual({ hello: 'world', n: 42 })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('leaves no *.tmp.* residue after a write', () => {
    const tmp = makeTempDir()
    try {
      const target = path.join(tmp, 'state', 'trade-log.json')
      atomicWriteJson(target, [1, 2, 3])
      const residue = listFilesRecursive(tmp).filter((f) => f.includes('.tmp.'))
      expect(residue).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('overwrites atomically (temp+rename): latest write wins, single file, no residue', () => {
    const tmp = makeTempDir()
    try {
      const target = path.join(tmp, 'file.json')
      atomicWriteJson(target, { v: 1 })
      atomicWriteJson(target, { v: 2 })
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
      expect(parsed).toEqual({ v: 2 })
      const residue = listFilesRecursive(tmp).filter((f) => f.includes('.tmp.'))
      expect(residue).toEqual([])
      // Exactly one real file exists
      const files = listFilesRecursive(tmp).filter((f) => !f.includes('.tmp.'))
      expect(files).toEqual(['file.json'])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})