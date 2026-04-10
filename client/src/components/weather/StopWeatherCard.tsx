import { Droplets, Snowflake, Thermometer, Wind, ExternalLink } from 'lucide-react'
import { Stop, StopWeather, LiveForecast, HistoricalWeather } from '../../types'

// React is needed for JSX and ReactNode type (no explicit import required with modern JSX transform,
// but ReactNode must be in scope for the ALERT_ICONS record type)
import type { ReactNode } from 'react'

// ─── Alert styles / icons ─────────────────────────────────────────────────────

export const ALERT_STYLES: Record<string, string> = {
  amber: 'bg-amber-50 border-amber-300 text-amber-800',
  blue:  'bg-blue-50  border-blue-300  text-blue-800',
  red:   'bg-red-50   border-red-300   text-red-800',
}

export const ALERT_ICONS: Record<string, ReactNode> = {
  wind:   <Wind        size={12} className="flex-shrink-0" />,
  rain:   <Droplets    size={12} className="flex-shrink-0" />,
  freeze: <Thermometer size={12} className="flex-shrink-0" />,
  snow:   <Snowflake   size={12} className="flex-shrink-0" />,
}

function shortDay(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-US', {
    weekday: 'short', month: 'numeric', day: 'numeric',
  })
}

// ─── StopWeatherCard ──────────────────────────────────────────────────────────

interface Props {
  stop: Stop
  weather: StopWeather | null | undefined
  /** Compact layout — used inside itinerary rows */
  compact?: boolean
}

export function StopWeatherCard({ stop, weather, compact = false }: Props) {
  // Still loading
  if (weather === undefined) {
    return <div className={`${compact ? 'mt-2 h-8' : 'mt-2 h-10'} rounded-lg bg-gray-100 animate-pulse`} />
  }
  if (weather === null) return null

  const nwsUrl = stop.latitude && stop.longitude
    ? `https://forecast.weather.gov/MapClick.php?lat=${stop.latitude}&lon=${stop.longitude}`
    : null

  // ── Historical mode ────────────────────────────────────────────────────────
  if (weather.mode === 'historical') {
    const w = weather as HistoricalWeather
    return (
      <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/40 px-3 py-2.5 text-xs">
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-semibold text-blue-800 flex items-center gap-1">
            <span>{w.icon}</span> Historical averages for {w.month}
          </span>
          {nwsUrl
            ? (
              <a
                href={nwsUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-0.5 text-[10px] text-[#1D9E75] hover:text-[#178a63] font-medium transition-colors"
              >
                View live forecast on NWS → <ExternalLink size={9} />
              </a>
            )
            : <span className="text-blue-400 italic text-[10px]">Live forecast within 10 days</span>
          }
        </div>
        <div className="flex items-center gap-4 text-gray-700 mb-1.5">
          <span className="text-base font-semibold">
            {w.avgHigh}°<span className="text-xs font-normal text-gray-500">high</span>
          </span>
          <span className="text-gray-400">·</span>
          <span className="text-base font-semibold">
            {w.avgLow}°<span className="text-xs font-normal text-gray-500">low</span>
          </span>
          <span className="text-gray-500 ml-1">{w.conditions}</span>
        </div>
        <div className="flex gap-4 text-gray-500 mb-2">
          {w.avgRainfall > 0 && (
            <span><Droplets size={11} className="inline mr-0.5 text-blue-400" />{w.avgRainfall}" avg rain</span>
          )}
          {w.avgSnowfall > 0 && (
            <span><Snowflake size={11} className="inline mr-0.5 text-blue-300" />{w.avgSnowfall}" avg snow</span>
          )}
        </div>
        {!compact && (
          <div className="space-y-0.5 text-gray-500">
            <div><span className="text-green-600 font-medium">Best case:</span> {w.bestCase}</div>
            <div><span className="text-red-500 font-medium">Worst case:</span> {w.worstCase}</div>
          </div>
        )}
      </div>
    )
  }

  // ── Live forecast mode ─────────────────────────────────────────────────────
  const w = weather as LiveForecast
  const allAlerts = w.days.flatMap(d => d.alerts)
  const uniqueAlerts = allAlerts.filter(
    (a, i, arr) => arr.findIndex(x => x.type === a.type) === i
  )

  return (
    <div className="mt-2 rounded-lg border border-[#1D9E75]/30 bg-green-50/30 px-3 py-2.5 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-[#1D9E75] flex items-center gap-1.5">
          📡 Live {w.days.length}-day forecast
        </span>
        {nwsUrl && (
          <a
            href={nwsUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-[#1D9E75] hover:text-[#178a63] transition-colors"
          >
            Full forecast <ExternalLink size={10} />
          </a>
        )}
      </div>

      {/* Alert banners */}
      {uniqueAlerts.length > 0 && (
        <div className="space-y-1 mb-2">
          {uniqueAlerts.map((alert, i) => (
            <div
              key={i}
              className={`flex items-center gap-1.5 border rounded px-2 py-1 ${ALERT_STYLES[alert.level]}`}
            >
              {ALERT_ICONS[alert.type]}
              {alert.message}
            </div>
          ))}
        </div>
      )}

      {/* Day-by-day — horizontally scrollable */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {w.days.map((day) => (
          <div
            key={day.date}
            className="flex-shrink-0 flex flex-col items-center gap-0.5 bg-white border border-gray-100 rounded-lg px-2 py-2 min-w-[62px]"
          >
            <span className="text-gray-500 text-[10px] whitespace-nowrap">{shortDay(day.date)}</span>
            <span className="text-lg leading-none">{day.icon}</span>
            <span className="font-semibold text-gray-800">{day.high}°</span>
            <span className="text-gray-400">{day.low}°</span>
            {day.precipProbability > 0 && (
              <span className="text-blue-500 text-[10px]">{day.precipProbability}%</span>
            )}
            {day.windSpeed > 0 && (
              <span className="text-gray-400 text-[10px]">{day.windSpeed}mph</span>
            )}
            {day.alerts.length > 0 && (
              <span className="text-[10px] mt-0.5">
                {day.alerts[0].level === 'red' ? '🔴' : day.alerts[0].level === 'amber' ? '🟡' : '🔵'}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
