/**
 * Pure Open-Meteo data-fetch functions — no Express, no Redis.
 * Used by both the weather route controller (Redis cache) and the
 * trips weather endpoint (DB cache).
 */

import axios from 'axios'

const METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const METEO_ARCHIVE_URL  = 'https://archive-api.open-meteo.com/v1/archive'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// ─── WMO weather code table ────────────────────────────────────────────────────

const WMO: Record<number, { desc: string; icon: string }> = {
  0:  { desc: 'Clear sky',            icon: '☀️' },
  1:  { desc: 'Mainly clear',         icon: '🌤️' },
  2:  { desc: 'Partly cloudy',        icon: '⛅' },
  3:  { desc: 'Overcast',             icon: '☁️' },
  45: { desc: 'Fog',                  icon: '🌫️' },
  48: { desc: 'Icy fog',              icon: '🌫️' },
  51: { desc: 'Light drizzle',        icon: '🌦️' },
  53: { desc: 'Drizzle',              icon: '🌦️' },
  55: { desc: 'Heavy drizzle',        icon: '🌧️' },
  61: { desc: 'Slight rain',          icon: '🌧️' },
  63: { desc: 'Moderate rain',        icon: '🌧️' },
  65: { desc: 'Heavy rain',           icon: '🌧️' },
  71: { desc: 'Slight snow',          icon: '🌨️' },
  73: { desc: 'Moderate snow',        icon: '🌨️' },
  75: { desc: 'Heavy snow',           icon: '❄️' },
  77: { desc: 'Snow grains',          icon: '🌨️' },
  80: { desc: 'Slight showers',       icon: '🌦️' },
  81: { desc: 'Showers',              icon: '🌧️' },
  82: { desc: 'Heavy showers',        icon: '⛈️' },
  85: { desc: 'Snow showers',         icon: '🌨️' },
  86: { desc: 'Heavy snow showers',   icon: '❄️' },
  95: { desc: 'Thunderstorm',         icon: '⛈️' },
  96: { desc: 'Thunderstorm w/ hail', icon: '⛈️' },
  99: { desc: 'Severe thunderstorm',  icon: '⛈️' },
}

export function wmoLookup(code: number) {
  return WMO[code] || { desc: 'Variable conditions', icon: '🌡️' }
}

export function buildAlerts(high: number, low: number, precipProb: number, snowfall: number, wind: number) {
  const alerts: Array<{ type: string; level: string; message: string }> = []
  if (wind > 25)       alerts.push({ type: 'wind',   level: 'amber', message: 'Wind advisory — large vehicles use caution' })
  if (precipProb > 70) alerts.push({ type: 'rain',   level: 'blue',  message: 'Rain likely — check road conditions' })
  if (low < 32)        alerts.push({ type: 'freeze', level: 'red',   message: 'Freezing temps — watch for ice' })
  if (snowfall > 0)    alerts.push({ type: 'snow',   level: 'red',   message: 'Snow possible — check road and campground access' })
  return alerts
}

export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ─── Live 10-day forecast ──────────────────────────────────────────────────────

export async function fetchLiveForecast(lat: number, lng: number, startDate: string, endDate: string) {
  const response = await axios.get(METEO_FORECAST_URL, {
    params: {
      latitude:      lat,
      longitude:     lng,
      start_date:    startDate,
      end_date:      endDate,
      forecast_days: 16,
      daily: [
        'weathercode', 'temperature_2m_max', 'temperature_2m_min',
        'precipitation_probability_max', 'precipitation_sum',
        'snowfall_sum', 'windspeed_10m_max',
      ].join(','),
      temperature_unit:   'fahrenheit',
      windspeed_unit:     'mph',
      precipitation_unit: 'inch',
      timezone: 'auto',
    },
    timeout: 8000,
  })

  const d = response.data.daily
  const days = d.time.map((date: string, i: number) => {
    const wmo   = wmoLookup(d.weathercode[i])
    const high  = Math.round(d.temperature_2m_max[i] ?? 0)
    const low   = Math.round(d.temperature_2m_min[i] ?? 0)
    const precip = d.precipitation_probability_max[i] ?? 0
    const snow  = d.snowfall_sum[i] ?? 0
    const wind  = Math.round(d.windspeed_10m_max[i] ?? 0)
    return {
      date,
      icon:             wmo.icon,
      conditions:       wmo.desc,
      high, low,
      precipProbability: precip,
      precipSum:        parseFloat((d.precipitation_sum[i] ?? 0).toFixed(2)),
      snowfall:         snow,
      windSpeed:        wind,
      alerts:           buildAlerts(high, low, precip, snow, wind),
    }
  })

  return { mode: 'live' as const, days }
}

// ─── Historical 3-year averages ────────────────────────────────────────────────

export async function fetchHistoricalWeather(
  lat: number, lng: number,
  monthN: number, dayN: number, daysN: number,
) {
  const currentYear = new Date().getFullYear()

  const yearResults = await Promise.all([1, 2, 3].map(async (yb) => {
    const year      = currentYear - yb
    const startDate = isoDate(new Date(year, monthN - 1, dayN))
    const endDate   = isoDate(new Date(year, monthN - 1, dayN + daysN - 1))
    try {
      const r = await axios.get(METEO_ARCHIVE_URL, {
        params: {
          latitude: lat, longitude: lng,
          start_date: startDate, end_date: endDate,
          daily: [
            'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum',
            'snowfall_sum', 'weathercode', 'windspeed_10m_max',
          ].join(','),
          temperature_unit:   'fahrenheit',
          windspeed_unit:     'mph',
          precipitation_unit: 'inch',
          timezone: 'auto',
        },
        timeout: 10000,
      })
      return r.data.daily
    } catch { return null }
  }))

  const valid = yearResults.filter(Boolean) as any[]
  if (!valid.length) return null

  const flatField = (field: string): number[] =>
    valid.flatMap(d => (d[field] as (number | null)[]).map(v => v ?? 0))
  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : 0

  const avgHigh    = Math.round(avg(flatField('temperature_2m_max')))
  const avgLow     = Math.round(avg(flatField('temperature_2m_min')))
  const avgRainfall = parseFloat(avg(valid.map(d =>
    (d.precipitation_sum as (number | null)[]).reduce((a, v) => a + (v ?? 0), 0)
  )).toFixed(1))
  const avgSnowfall = parseFloat(avg(valid.map(d =>
    (d.snowfall_sum as (number | null)[]).reduce((a, v) => a + (v ?? 0), 0)
  )).toFixed(1))

  const allCodes = flatField('weathercode').map(Math.round)
  const codeCounts: Record<number, number> = {}
  for (const c of allCodes) codeCounts[c] = (codeCounts[c] || 0) + 1
  const topCode = parseInt(Object.entries(codeCounts).sort((a, b) => +b[1] - +a[1])[0][0])
  const wmo = wmoLookup(topCode)

  let conditions = wmo.desc
  if (avgHigh >= 90 && avgRainfall < 0.3)       conditions = 'Hot and dry'
  else if (avgHigh >= 80 && avgRainfall < 0.5)   conditions = 'Warm and sunny'
  else if (avgHigh >= 70 && avgRainfall < 1)     conditions = 'Warm and dry'
  else if (avgHigh >= 65 && avgRainfall >= 1)    conditions = 'Warm with some rain'
  else if (avgHigh >= 55 && avgRainfall >= 1.5)  conditions = 'Cool with afternoon showers'
  else if (avgSnowfall > 0.5)                    conditions = 'Cold with possible snow'
  else if (avgHigh < 40)                         conditions = 'Cold — pack layers'

  return {
    mode: 'historical' as const,
    month: MONTHS[monthN - 1],
    avgHigh, avgLow, avgRainfall, avgSnowfall, conditions,
    icon: wmo.icon,
    bestCase: avgHigh > 70
      ? `Highs around ${avgHigh + 5}°F, clear skies`
      : `Highs around ${avgHigh}°F with sunshine`,
    worstCase: avgSnowfall > 0.5
      ? `Snow possible, lows near ${avgLow}°F`
      : avgRainfall > 1.5
        ? `Heavy rain, lows near ${avgLow}°F`
        : `Overcast, lows near ${avgLow}°F`,
  }
}
