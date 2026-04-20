import { Response, NextFunction } from 'express'
import { AuthRequest } from '../middleware/auth'
import { getCache, setCache } from '../utils/redis'
import {
  fetchLiveForecast, fetchHistoricalWeather, buildAlerts,
} from '../services/weatherFetch'

// ─── Live 10-day forecast (Open-Meteo, free) ──────────────────────────────────

export async function getLiveForecast(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lat, lng, start_date, end_date } = req.query
    if (!lat || !lng || !start_date || !end_date)
      return res.status(400).json({ error: 'lat, lng, start_date, end_date required' })

    const cacheKey = `meteo:forecast:${lat}:${lng}:${start_date}:${end_date}`
    const cached = await getCache(cacheKey)
    if (cached) return res.json(cached)

    const result = await fetchLiveForecast(
      parseFloat(lat as string),
      parseFloat(lng as string),
      start_date as string,
      end_date as string,
    )
    await setCache(cacheKey, result, 1800) // 30 min
    res.json(result)
  } catch (err) { next(err) }
}

// ─── Historical averages (Open-Meteo Archive, 3-year average) ─────────────────

export async function getHistoricalWeather(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lat, lng, month, day, days } = req.query
    if (!lat || !lng || !month)
      return res.status(400).json({ error: 'lat, lng, month required' })

    const cacheKey = `meteo:historical:${lat}:${lng}:${month}:${day}:${days}`
    const cached = await getCache(cacheKey)
    if (cached) return res.json(cached)

    const result = await fetchHistoricalWeather(
      parseFloat(lat  as string),
      parseFloat(lng  as string),
      parseInt(month  as string),
      parseInt((day   as string) || '1'),
      parseInt((days  as string) || '7'),
    )
    if (!result) return res.json(null)
    await setCache(cacheKey, result, 86400) // 24h
    res.json(result)
  } catch (err) { next(err) }
}

// Re-export buildAlerts for any callers that imported it from here
export { buildAlerts }
