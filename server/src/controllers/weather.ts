import { Response, NextFunction } from 'express'
import axios from 'axios'
import { AuthRequest } from '../middleware/auth'
import { getCache, setCache } from '../utils/redis'
import {
  fetchLiveForecast, fetchHistoricalWeather, buildAlerts,
} from '../services/weatherFetch'

// ─── Legacy OpenWeather (kept for backwards compat) ───────────────────────────

const OWM_BASE = 'https://api.openweathermap.org/data/2.5'

async function fetchForecast(lat: number, lng: number, date?: string) {
  const cacheKey = `weather:${lat}:${lng}:${date || 'now'}`
  const cached = await getCache(cacheKey)
  if (cached) return cached

  try {
    const res = await axios.get(`${OWM_BASE}/forecast`, {
      params: { lat, lon: lng, appid: process.env.OPENWEATHER_API_KEY, units: 'imperial', cnt: 40 },
      timeout: 5000,
    })
    const forecast = res.data.list.slice(0, 5).map((item: any) => ({
      date: new Date(item.dt * 1000).toISOString(),
      temp: { min: item.main.temp_min, max: item.main.temp_max, feels: item.main.feels_like },
      conditions: item.weather[0].description,
      icon: item.weather[0].icon,
      wind: item.wind.speed,
      humidity: item.main.humidity,
      precipitation: item.pop,
      alerts: getLegacyAlerts(item),
    }))
    await setCache(cacheKey, forecast, 1800)
    return forecast
  } catch (e) {
    console.error('Weather API error:', e)
    return null
  }
}

function getLegacyAlerts(item: any): string[] {
  const alerts: string[] = []
  if (item.wind.speed > 25) alerts.push('Wind advisory')
  if (item.main.temp_max > 100) alerts.push('Extreme heat warning')
  if (item.main.temp_min < 32) alerts.push('Freezing temperatures')
  if (item.weather[0].main === 'Snow') alerts.push('Snow expected')
  if (item.weather[0].main === 'Thunderstorm') alerts.push('Thunderstorm warning')
  return alerts
}

export async function getRouteWeather(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { stops, dates } = req.query
    const stopsArr = JSON.parse((stops as string) || '[]')
    const datesArr = JSON.parse((dates as string) || '[]')
    const forecasts = await Promise.all(
      stopsArr.map(async (stop: { lat: number; lng: number }, i: number) => {
        const forecast = await fetchForecast(stop.lat, stop.lng, datesArr[i])
        return { stopIndex: i, forecast }
      })
    )
    res.json(forecasts)
  } catch (err) { next(err) }
}

export async function getStopWeather(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lat, lng, date } = req.query
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' })
    const forecast = await fetchForecast(parseFloat(lat as string), parseFloat(lng as string), date as string)
    res.json(forecast)
  } catch (err) { next(err) }
}

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
