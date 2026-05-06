import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { createServerClient } from '@/lib/supabase'
import { summarizeError } from '@/lib/logging'

export type RpcProvider = 'helius'

const PROVIDER_HELIUS: RpcProvider = 'helius'

const DEFAULT_HELIUS_MIN_INTERVAL_MS = 750
const DEFAULT_HELIUS_BURST = 1
const DEFAULT_HELIUS_429_COOLDOWN_MS = 30_000
const DEFAULT_HELIUS_429_WRITE_MIN_INTERVAL_MS = 10_000
const DEFAULT_HELIUS_MAX_ATTEMPTS = 1

type CooldownState = {
  untilMs: number
  lastWriteAtMs: number
  lastLoggedUntilMs: number
  warnedReadFailure: boolean
  warnedWriteFailure: boolean
}

class RpcProviderCooldownError extends Error {
  constructor(provider: RpcProvider, waitMs: number) {
    super(`[rpc-rate-limit] ${provider} cooling down for ${Math.ceil(waitMs / 1_000)}s`)
    this.name = 'RpcProviderCooldownError'
  }
}

class TokenBucket {
  private tokens: number
  private updatedAtMs = Date.now()

  constructor(
    private readonly capacity: number,
    private readonly refillIntervalMs: number,
  ) {
    this.tokens = capacity
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now()
      this.refill(now)

      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }

      const waitMs = Math.max(1, Math.ceil((1 - this.tokens) * this.refillIntervalMs))
      await sleep(waitMs)
    }
  }

  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.updatedAtMs
    if (elapsedMs <= 0) return

    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedMs / this.refillIntervalMs,
    )
    this.updatedAtMs = nowMs
  }
}

const cooldowns: Record<RpcProvider, CooldownState> = {
  helius: {
    untilMs: 0,
    lastWriteAtMs: 0,
    lastLoggedUntilMs: 0,
    warnedReadFailure: false,
    warnedWriteFailure: false,
  },
}

const buckets: Partial<Record<RpcProvider, TokenBucket>> = {}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function intEnv(name: string, fallback: number, min: number, max?: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  const value = Number.isFinite(parsed) ? parsed : fallback
  const bounded = Math.max(min, value)
  return max === undefined ? bounded : Math.min(max, bounded)
}

function getBucket(provider: RpcProvider): TokenBucket {
  const existing = buckets[provider]
  if (existing) return existing

  if (provider === PROVIDER_HELIUS) {
    const bucket = new TokenBucket(
      intEnv('HELIUS_RATE_LIMIT_BURST', DEFAULT_HELIUS_BURST, 1, 10),
      intEnv('HELIUS_RATE_LIMIT_MIN_INTERVAL_MS', DEFAULT_HELIUS_MIN_INTERVAL_MS, 100),
    )
    buckets[provider] = bucket
    return bucket
  }

  throw new Error(`[rpc-rate-limit] unsupported provider ${provider}`)
}

function getCooldownMs(provider: RpcProvider): number {
  if (provider === PROVIDER_HELIUS) {
    return intEnv('HELIUS_429_COOLDOWN_MS', DEFAULT_HELIUS_429_COOLDOWN_MS, 1_000)
  }
  return DEFAULT_HELIUS_429_COOLDOWN_MS
}

function getCooldownWriteMinIntervalMs(provider: RpcProvider): number {
  if (provider === PROVIDER_HELIUS) {
    return intEnv(
      'HELIUS_429_WRITE_MIN_INTERVAL_MS',
      DEFAULT_HELIUS_429_WRITE_MIN_INTERVAL_MS,
      1_000,
    )
  }
  return DEFAULT_HELIUS_429_WRITE_MIN_INTERVAL_MS
}

export function getHeliusMaxAttempts(): number {
  return intEnv('HELIUS_MAX_ATTEMPTS', DEFAULT_HELIUS_MAX_ATTEMPTS, 1, 5)
}

export function isHeliusRpcEndpoint(rpcUrl: string): boolean {
  try {
    const parsed = new URL(rpcUrl)
    return parsed.hostname.toLowerCase().endsWith('helius-rpc.com')
  } catch {
    return /helius-rpc\.com/i.test(rpcUrl)
  }
}

export function isRpcProviderCooldownError(error: unknown): boolean {
  return error instanceof RpcProviderCooldownError
}

export function isRpcRateLimitError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? error.status
    if (status === 429) return true
  }

  if (error instanceof Error) {
    return /\b429\b|too many requests|rate limit/i.test(error.message)
  }

  return false
}

export async function refreshRpcProviderCooldown(provider: RpcProvider): Promise<void> {
  try {
    const { data, error } = await createServerClient()
      .from('rpc_provider_cooldowns')
      .select('cooldown_until')
      .eq('provider', provider)
      .maybeSingle()

    if (error) throw error

    const cooldownUntil = typeof data?.cooldown_until === 'string'
      ? Date.parse(data.cooldown_until)
      : 0
    cooldowns[provider].untilMs = Number.isFinite(cooldownUntil) ? cooldownUntil : 0
    cooldowns[provider].warnedReadFailure = false
  } catch (err) {
    if (!cooldowns[provider].warnedReadFailure) {
      cooldowns[provider].warnedReadFailure = true
      console.warn(`[rpc-rate-limit] ${provider} cooldown read failed: ${summarizeError(err)}`)
    }
  }
}

export async function recordRpcProvider429(provider: RpcProvider, error?: unknown): Promise<void> {
  const now = Date.now()
  const cooldownUntilMs = now + getCooldownMs(provider)
  const state = cooldowns[provider]
  state.untilMs = Math.max(state.untilMs, cooldownUntilMs)

  const minWriteIntervalMs = getCooldownWriteMinIntervalMs(provider)
  if (now - state.lastWriteAtMs < minWriteIntervalMs) return
  state.lastWriteAtMs = now

  try {
    const { error: dbError } = await createServerClient()
      .from('rpc_provider_cooldowns')
      .upsert({
        provider,
        cooldown_until: new Date(state.untilMs).toISOString(),
        last_status: 429,
        last_error: error ? summarizeError(error, 500) : '429 Too Many Requests',
      }, { onConflict: 'provider' })

    if (dbError) throw dbError
    state.warnedWriteFailure = false
    console.warn(`[rpc-rate-limit] ${provider} 429 cooldown until ${new Date(state.untilMs).toISOString()}`)
  } catch (err) {
    if (!state.warnedWriteFailure) {
      state.warnedWriteFailure = true
      console.warn(`[rpc-rate-limit] ${provider} cooldown write failed: ${summarizeError(err)}`)
    }
  }
}

export async function awaitRpcProviderSlot(provider: RpcProvider, context: string): Promise<void> {
  const waitMs = cooldowns[provider].untilMs - Date.now()
  if (waitMs > 0) {
    if (cooldowns[provider].lastLoggedUntilMs !== cooldowns[provider].untilMs) {
      cooldowns[provider].lastLoggedUntilMs = cooldowns[provider].untilMs
      console.warn(`[rpc-rate-limit] ${provider} cooldown active for ${Math.ceil(waitMs / 1_000)}s (${context})`)
    }
    throw new RpcProviderCooldownError(provider, waitMs)
  }

  await getBucket(provider).take()

  const postWaitMs = cooldowns[provider].untilMs - Date.now()
  if (postWaitMs > 0) {
    throw new RpcProviderCooldownError(provider, postWaitMs)
  }
}

export async function heliusAxiosPost<T = unknown>(
  rpcUrl: string,
  payload: unknown,
  config: AxiosRequestConfig = {},
  context = 'helius-rpc',
): Promise<AxiosResponse<T>> {
  await awaitRpcProviderSlot(PROVIDER_HELIUS, context)

  try {
    return await axios.post<T>(rpcUrl, payload, config)
  } catch (err) {
    if (isRpcRateLimitError(err)) {
      await recordRpcProvider429(PROVIDER_HELIUS, err)
    }
    throw err
  }
}

export const heliusRpcFetch: typeof fetch = async (input, init) => {
  try {
    await awaitRpcProviderSlot(PROVIDER_HELIUS, 'web3-connection')
  } catch (err) {
    if (isRpcProviderCooldownError(err)) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: 429, message: err instanceof Error ? err.message : 'RPC provider cooling down' },
          id: null,
        }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }
    throw err
  }

  const res = await fetch(input, init)
  if (res.status === 429) {
    await recordRpcProvider429(PROVIDER_HELIUS)
  }
  return res
}
