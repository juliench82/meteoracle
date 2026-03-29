import { kv } from '@vercel/kv'

// Thin wrapper around Vercel KV for type-safe access
export const redis = {
  async get<T>(key: string): Promise<T | null> {
    return kv.get<T>(key)
  },
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await kv.set(key, value, { ex: ttlSeconds })
    } else {
      await kv.set(key, value)
    }
  },
  async del(key: string): Promise<void> {
    await kv.del(key)
  },
  async publish(channel: string, message: unknown): Promise<void> {
    await kv.publish(channel, JSON.stringify(message))
  },
}
