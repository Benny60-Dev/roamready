import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Map, Share2, Download, BookOpen, Package, Calendar, DollarSign,
  Tent, ChevronRight, AlertTriangle, CheckCircle, Clock, XCircle,
  Wind, Droplets, Snowflake, Thermometer, ExternalLink,
} from 'lucide-react'
import { tripsApi, weatherApi } from '../../services/api'
import { Trip, Stop, StopWeather, LiveForecast, HistoricalWeather } from '../../types'
import { format } from 'date-fns'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate)
  d.setDate(d.getDate() + n)
  return isoDateStr(d)
}

function shortDay(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })
}

// ─── Alert banners ────────────────────────────────────────────────────────────

const ALERT_STYLES: Record<string, string> = {
  amber: 'bg-amber-50 border-amber-300 text-amber-800',
  blue:  'bg-blue-50 border-blue-300 text-blue-800',
  red:   'bg-red-50 border-red-300 text-red-800',
}

const ALERT_ICONS: Record<string, JSX.Element> = {
  wind:   <Wind    size={12} className="flex-shrink-0" />,
  rain:   <Droplets size={12} className="flex-shrink-0" />,
  freeze: <Thermometer size={12} className="flex-shrink-0" />,
  snow:   <Snowflake size={12} className="flex-shrink-0" />,
}

// ─── Weather card ─────────────────────────────────────────────────────────────

function StopWeatherCard({ stop, weather }: { stop: Stop; weather: StopWeather | null | undefined }) {
  if (weather === undefined) {
    // Still loading
    return (
      <div className="mt-2 h-10 rounded-lg bg-gray-100 animate-pulse" />
    )
  }
  if (weather === null) return null

  const nwsUrl = stop.latitude && stop.longitude
    ? `https://forecast.weather.gov/MapClick.php?lat=${stop.latitude}&lon=${stop.longitude}`
    : null

  // ── Historical mode ──────────────────────────────────────────────────────────
  if (weather.mode === 'historical') {
    const w = weather as HistoricalWeather
    return (
      <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/40 px-3 py-2.5 text-xs">
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-semibold text-blue-800 flex items-center gap-1">
            <span>{w.icon}</span> Historical averages for {w.month}
          </span>
          <span className="text-blue-500 italic">Live forecast within 10 days</span>
        </div>
        {/* Temp row */}
        <div className="flex items-center gap-4 text-gray-700 mb-1.5">
          <span className="text-base font-semibold">{w.avgHigh}°<span className="text-xs font-normal text-gray-500">high</span></span>
          <span className="text-gray-400">·</span>
          <span className="text-base font-semibold">{w.avgLow}°<span className="text-xs font-normal text-gray-500">low</span></span>
          <span className="text-gray-500 ml-1">{w.conditions}</span>
        </div>
        {/* Precip row */}
        <div className="flex gap-4 text-gray-500 mb-2">
          {w.avgRainfall > 0 && <span><Droplets size={11} className="inline mr-0.5 text-blue-400" />{w.avgRainfall}" avg rain</span>}
          {w.avgSnowfall > 0 && <span><Snowflake size={11} className="inline mr-0.5 text-blue-300" />{w.avgSnowfall}" avg snow</span>}
        </div>
        {/* Best / worst */}
        <div className="space-y-0.5 text-gray-500">
          <div><span className="text-green-600 font-medium">Best case:</span> {w.bestCase}</div>
          <div><span className="text-red-500 font-medium">Worst case:</span> {w.worstCase}</div>
        </div>
      </div>
    )
  }

  // ── Live forecast mode ───────────────────────────────────────────────────────
  const w = weather as LiveForecast
  const allAlerts = w.days.flatMap(d => d.alerts)
  // Deduplicate by type
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

      {/* Day-by-day forecast — horizontally scrollable */}
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

// ─── Stop row ─────────────────────────────────────────────────────────────────

function StopRow({ stop, tripId, weather }: { stop: Stop; tripId: string; weather: StopWeather | null | undefined }) {
  // Derive alert count for badge
  const alertCount = weather?.mode === 'live'
    ? (weather as LiveForecast).days.flatMap(d => d.alerts).filter(
        (a, i, arr) => arr.findIndex(x => x.type === a.type) === i
      ).length
    : 0

  function StopActionBadge() {
    if (stop.bookingStatus === 'CONFIRMED') {
      return (
        <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-green-100 text-green-700 flex-shrink-0">
          <CheckCircle size={11} /> Booked
        </span>
      )
    }
    if (stop.bookingStatus === 'PENDING' || stop.bookingStatus === 'WAITLISTED') {
      return (
        <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 flex-shrink-0">
          <Clock size={11} /> Pending
        </span>
      )
    }
    if (stop.bookingStatus === 'CANCELLED') {
      return (
        <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-red-100 text-red-500 flex-shrink-0">
          <XCircle size={11} /> Cancelled
        </span>
      )
    }
    // NOT_BOOKED — show Reserve button for all stop types
    return (
      <Link
        to={`/trips/${tripId}/booking?stopId=${stop.id}`}
        className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-full bg-[#1D9E75] text-white hover:bg-[#178a63] transition-colors flex-shrink-0 whitespace-nowrap"
        onClick={e => e.stopPropagation()}
      >
        Reserve
      </Link>
    )
  }

  return (
    <div className={`card ${!stop.isCompatible ? 'border-red-200 bg-red-50/30' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-medium ${
            stop.type === 'OVERNIGHT_ONLY' ? 'bg-[#7F77DD]' : 'bg-[#1D9E75]'
          }`}>
            {stop.order}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">
                {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
              </p>
              {stop.campgroundName && <p className="text-xs text-gray-500 mt-0.5">{stop.campgroundName}</p>}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {alertCount > 0 && (
                <span className="text-amber-500 text-xs font-medium flex items-center gap-0.5">
                  <AlertTriangle size={12} />{alertCount}
                </span>
              )}
              {!stop.isCompatible && <AlertTriangle size={14} className="text-red-500" />}
              <StopActionBadge />
            </div>
          </div>

          {!stop.isCompatible && stop.incompatibilityReasons && (
            <div className="mt-1 text-xs text-red-600 bg-red-50 rounded px-2 py-1">
              {stop.incompatibilityReasons.join(' • ')}
            </div>
          )}

          <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
            {stop.arrivalDate && (
              <span><Calendar size={11} className="inline mr-0.5" />{format(new Date(stop.arrivalDate), 'MMM d')}</span>
            )}
            <span><Tent size={11} className="inline mr-0.5" />{stop.nights} night{stop.nights !== 1 ? 's' : ''}</span>
            {stop.siteRate && <span><DollarSign size={11} className="inline mr-0.5" />${stop.siteRate}/night</span>}
            {stop.hookupType && <span className="badge-green">{stop.hookupType}</span>}
            {stop.isPetFriendly === true && <span className="text-[#1D9E75]">🐾 Pet-friendly</span>}
            {stop.isMilitaryOnly && <span className="text-blue-600">🎖️ Military</span>}
          </div>

          {/* Weather card */}
          {stop.latitude && stop.longitude && (
            <StopWeatherCard stop={stop} weather={weather} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [loading, setLoading] = useState(true)
  // undefined = not yet fetched, null = failed, StopWeather = loaded
  const [weatherData, setWeatherData] = useState<Record<string, StopWeather | null | undefined>>({})

  useEffect(() => {
    if (!id) return
    tripsApi.get(id)
      .then(res => { setTrip(res.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [id])

  // Fetch weather for all stops once trip loads
  useEffect(() => {
    if (!trip?.stops?.length) return

    const today = new Date()
    const tripStart = trip.startDate ? new Date(trip.startDate) : null
    const daysUntilTrip = tripStart
      ? Math.ceil((tripStart.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
      : null
    // Use live forecast if trip starts within 10 days (or is already underway)
    const useLive = daysUntilTrip !== null && daysUntilTrip <= 10

    // Mark all stops with lat/lng as loading (undefined)
    const initial: Record<string, StopWeather | null | undefined> = {}
    for (const s of trip.stops) {
      if (s.latitude && s.longitude) initial[s.id] = undefined
    }
    setWeatherData(initial)

    Promise.all(
      trip.stops
        .filter(s => s.latitude && s.longitude)
        .map(async (stop) => {
          try {
            if (useLive && stop.arrivalDate) {
              const startDate = stop.arrivalDate.split('T')[0]
              const endDate   = addDays(startDate, stop.nights)
              const res = await weatherApi.forecast({
                lat: stop.latitude!,
                lng: stop.longitude!,
                start_date: startDate,
                end_date:   endDate,
              })
              return { id: stop.id, data: res.data as StopWeather }
            } else if (!useLive && stop.arrivalDate) {
              const d = new Date(stop.arrivalDate)
              const res = await weatherApi.historical({
                lat:   stop.latitude!,
                lng:   stop.longitude!,
                month: d.getMonth() + 1,
                day:   d.getDate(),
                days:  stop.nights || 1,
              })
              return { id: stop.id, data: res.data as StopWeather }
            }
            return { id: stop.id, data: null }
          } catch {
            return { id: stop.id, data: null }
          }
        })
    ).then(results => {
      setWeatherData(prev => {
        const next = { ...prev }
        for (const r of results) next[r.id] = r.data
        return next
      })
    })
  }, [trip?.id])

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="w-6 h-6 border-2 border-[#1D9E75] border-t-transparent rounded-full animate-spin" />
    </div>
  )
  if (!trip) return <div className="text-center py-20 text-gray-500">Trip not found</div>

  const totalCost   = (trip.estimatedFuel || 0) + (trip.estimatedCamp || 0)
  const bookedStops = trip.stops?.filter(s => s.bookingStatus === 'CONFIRMED').length || 0
  const totalStops  = trip.stops?.length || 0

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-medium text-gray-900">{trip.name}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{trip.startLocation} → {trip.endLocation}</p>
        </div>
        <div className="flex gap-2">
          <Link to={`/trips/${id}/map`} className="btn-outline text-sm flex items-center gap-1.5">
            <Map size={14} /> Map
          </Link>
          <Link to={`/trips/${id}/booking`} className="btn-primary text-sm flex items-center gap-1.5">
            Reserve <ChevronRight size={14} />
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Miles',   value: trip.totalMiles?.toLocaleString() || '–', icon: Map },
          { label: 'Nights',  value: trip.totalNights || '–',                  icon: Tent },
          { label: 'Est. cost', value: totalCost ? `$${totalCost.toLocaleString()}` : '–', icon: DollarSign },
          { label: 'Booked',  value: `${bookedStops}/${totalStops}`,            icon: CheckCircle },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="card text-center">
            <Icon size={16} className="text-[#1D9E75] mx-auto mb-1" />
            <div className="text-lg font-medium text-gray-900">{value}</div>
            <div className="text-xs text-gray-500">{label}</div>
          </div>
        ))}
      </div>

      {/* Action links */}
      <div className="flex flex-wrap gap-2">
        <Link to={`/trips/${id}/itinerary`} className="btn-ghost text-sm flex items-center gap-1.5"><Calendar size={14} /> Itinerary</Link>
        <Link to={`/trips/${id}/journal`}  className="btn-ghost text-sm flex items-center gap-1.5"><BookOpen size={14} /> Journal</Link>
        <Link to={`/packing/${id}`}         className="btn-ghost text-sm flex items-center gap-1.5"><Package  size={14} /> Packing list</Link>
        <button className="btn-ghost text-sm flex items-center gap-1.5"><Share2   size={14} /> Share</button>
        <button className="btn-ghost text-sm flex items-center gap-1.5"><Download size={14} /> PDF</button>
      </div>

      {/* Stops */}
      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Stops ({totalStops})</h2>
        {trip.stops?.length === 0 ? (
          <div className="card text-center py-8 text-sm text-gray-500">
            No stops yet — <Link to={`/trips/${id}/map`} className="text-[#1D9E75]">add stops on the map</Link>
          </div>
        ) : (
          <div className="space-y-2">
            {trip.stops?.sort((a, b) => a.order - b.order).map((stop, idx, arr) => {
              // Safety net: first and last stops are never OVERNIGHT_ONLY regardless of DB value
              const isEndpoint = idx === 0 || idx === arr.length - 1
              const displayStop = isEndpoint && stop.type === 'OVERNIGHT_ONLY'
                ? { ...stop, type: 'DESTINATION' as const }
                : stop
              return (
                <StopRow
                  key={stop.id}
                  stop={displayStop}
                  tripId={id!}
                  weather={weatherData[stop.id]}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
