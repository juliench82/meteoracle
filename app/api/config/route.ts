import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

const ENV_PATH = path.resolve(process.cwd(), '.env.local')

// Variables we allow editing from the UI, grouped by category
const EDITABLE_VARS = {
  global: [
    'MAX_CONCURRENT_MARKET_LP_POSITIONS',
    'MAX_MARKET_LP_SOL_PER_POSITION',
    'MAX_MARKET_LP_SOL_DEPLOYED',
    'WALLET_MIN_SOL_RESERVE',
  ],
  evilPanda: [
    'EVIL_PANDA_MAX_AGE_HOURS',
    'EVIL_PANDA_MIN_RUGCHECK_SCORE',
    'EVIL_PANDA_MIN_HOLDER_COUNT',
    'EVIL_PANDA_MIN_LIQUIDITY_USD',
  ],
  scalpSpike: [
    'SCALP_SPIKE_MIN_MC_USD',
    'SCALP_SPIKE_MIN_RUGCHECK_SCORE',
    'SCALP_SPIKE_MIN_HOLDER_COUNT',
    'SCALP_SPIKE_MIN_LIQUIDITY_USD',
  ],
  scanner: [
    'LP_SCAN_INTERVAL_SEC',
    'FRESH_SNIPE_MAX_AGE_MINUTES',
    'FRESH_SCANNER_MAX_AGE_MINUTES',
    'FRESH_MIN_LIQUIDITY_USD',
    'CANDIDATE_DEDUP_HOURS',
    'MAX_DEEP_CHECKS',
    'DEEP_CHECK_DELAY_MS',
    'MIN_SCORE_TO_OPEN',
    'MATURE_MIN_SCORE_TO_OPEN',
    'MOMENTUM_POOL_LIMIT',
    'HELIUS_HOLDER_MAX_PAGES',
  ],
  features: [
    'EVIL_PANDA_ENABLED',
    'SCALP_SPIKE_ENABLED',
    'LP_SCANNER_ENABLED',
    'STABLE_FARM_ENABLED',
    'BLUECHIP_FARM_ENABLED',
    'MOONBOY_ENABLED',
    'HELIUS_ENABLED',
  ],
}

function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {}
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key) {
      env[key.trim()] = rest.join('=').trim()
    }
  }
  return env
}

async function readEnvFile(): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(ENV_PATH, 'utf8')
    return parseEnv(content)
  } catch {
    return {}
  }
}

async function writeEnvFile(updates: Record<string, string>) {
  const current = await readEnvFile()
  const merged = { ...current, ...updates }

  const lines: string[] = []
  // Keep some structure and comments if possible (simple version)
  lines.push('# Updated via Dashboard Config')
  lines.push('')

  for (const [key, value] of Object.entries(merged)) {
    lines.push(`${key}=${value}`)
  }

  await fs.writeFile(ENV_PATH, lines.join('\n') + '\n', 'utf8')
}

export async function GET() {
  const env = await readEnvFile()

  const grouped: Record<string, Record<string, string>> = {}

  for (const [group, keys] of Object.entries(EDITABLE_VARS)) {
    grouped[group] = {}
    for (const key of keys) {
      grouped[group][key] = env[key] ?? ''
    }
  }

  return NextResponse.json({ groups: grouped, allKeys: EDITABLE_VARS })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const updates: Record<string, string> = {}

    // Only allow known keys
    const allAllowedKeys = Object.values(EDITABLE_VARS).flat()
    for (const [key, value] of Object.entries(body)) {
      if (allAllowedKeys.includes(key)) {
        updates[key] = String(value)
      }
    }

    await writeEnvFile(updates)

    return NextResponse.json({ success: true, updated: Object.keys(updates) })
  } catch (error) {
    console.error('Config update error:', error)
    return NextResponse.json({ error: 'Failed to update config' }, { status: 500 })
  }
}
