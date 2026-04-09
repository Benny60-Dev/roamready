import { createClient } from 'redis'

export const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' })

redis.on('error', (err) => console.error('Redis error:', err))

redis.connect().catch(console.error)

export async function getCache<T>(key: string): Promise<T | null> {
  const data = await redis.get(key)
  if (!data) return null
  return JSON.parse(data) as T
}

export async function setCache(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  await redis.setEx(key, ttlSeconds, JSON.stringify(value))
}

export async function deleteCache(key: string): Promise<void> {
  await redis.del(key)
}
