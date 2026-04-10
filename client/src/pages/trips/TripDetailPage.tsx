import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import {
  Map, Share2, Download, BookOpen, Package, Calendar, DollarSign,
  Tent, ChevronRight, AlertTriangle, CheckCircle, Clock, XCircle,
  Wind, CloudRain,
} from 'lucide-react'
import { tripsApi } from '../../services/api'
import { Trip, Stop, StopWeather, LiveForecast } from '../../types'
import { format } from 'date-fns'
import { StopWeatherCard, ALERT_STYLES, ALERT_ICONS } from '../../components/weather/StopWeatherCard'

// ─── Stop row ─────────────────────────────────────────────────────────────────

function StopRow({ stop, tripId, weather }: { stop: Stop; tripId: string; weather: StopWeather | null | undefined }) {
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

          {stop.latitude && stop.longitude && (
            <StopWeatherCard stop={stop} weather={weather} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Weather tab ──────────────────────────────────────────────────────────────

function WeatherTab({ trip, weatherData, loading }: {
  trip: Trip
  weatherData: Record<string, StopWeather | null | undefined>
  loading: boolean
}) {
  // All non-HOME stops, with or without coords
  const nonHomeStops = (trip.stops || [])
    .filter(s => s.type !== 'HOME')
    .sort((a, b) => a.order - b.order)

  // Collect all unique alerts across all stops
  const allAlerts = nonHomeStops.flatMap(stop => {
    const w = weatherData[stop.id]
    if (!w || w.mode !== 'live') return []
    return (w as LiveForecast).days.flatMap(d => d.alerts).map(a => ({ ...a, stopName: stop.locationName }))
  })
  const uniqueAlertTypes = allAlerts.filter(
    (a, i, arr) => arr.findIndex(x => x.type === a.type) === i
  )

  if (nonHomeStops.length === 0) {
    return (
      <p className="text-sm text-gray-500 text-center py-8">
        No stops added yet.
      </p>
    )
  }

  // Show a global loading spinner only while the very first fetch is in flight
  // and no data has arrived yet
  const hasAnyData = Object.keys(weatherData).length > 0

  return (
    <div className="space-y-4">
      {loading && !hasAnyData && (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
          <div className="w-4 h-4 border-2 border-[#1D9E75] border-t-transparent rounded-full animate-spin" />
          Loading weather data…
        </div>
      )}

      {/* Route weather alerts summary */}
      {uniqueAlertTypes.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs font-semibold text-amber-800 mb-2 flex items-center gap-1.5">
            <AlertTriangle size={13} /> Weather alerts along this route
          </p>
          <div className="space-y-1">
            {uniqueAlertTypes.map((alert, i) => (
              <div key={i} className={`flex items-center gap-1.5 border rounded px-2 py-1 text-xs ${ALERT_STYLES[alert.level]}`}>
                {ALERT_ICONS[alert.type]}
                <span>{alert.message}</span>
                <span className="ml-auto text-[10px] opacity-70">at {alert.stopName}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-stop weather */}
      {nonHomeStops.map(stop => {
        const hasCoords = !!(stop.latitude && stop.longitude)
        // undefined = still loading, null = fetch returned nothing, StopWeather = data
        const w = weatherData[stop.id]
        // If fetch is done but server returned no entry for this stop, it has no coords
        const fetchDone = hasAnyData && !loading
        return (
          <div key={stop.id}>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-5 h-5 rounded-full bg-[#1D9E75] flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                {stop.order}
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
                </p>
                {stop.campgroundName && (
                  <p className="text-xs text-gray-500">{stop.campgroundName}</p>
                )}
              </div>
              {stop.arrivalDate && (
                <span className="ml-auto text-xs text-gray-400">
                  {format(new Date(stop.arrivalDate), 'MMM d')} · {stop.nights}n
                </span>
              )}
            </div>
            {!hasCoords ? (
              <p className="text-xs text-gray-400 italic mt-1 ml-7">
                No coordinates — visit the map to geocode this stop.
              </p>
            ) : fetchDone && w === undefined ? (
              <p className="text-xs text-gray-400 italic mt-1 ml-7">
                Weather unavailable for this stop.
              </p>
            ) : (
              <StopWeatherCard stop={stop} weather={w} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'stops' | 'weather'

export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [trip, setTrip]               = useState<Trip | null>(null)
  const [loading, setLoading]         = useState(true)
  const [tab, setTab]                 = useState<Tab>('stops')
  const [weatherData, setWeatherData] = useState<Record<string, StopWeather | null | undefined>>({})
  const [weatherLoading, setWeatherLoading] = useState(false)

  useEffect(() => {
    if (!id) return
    tripsApi.get(id)
      .then(res => { setTrip(res.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [id])

  // Sync estimatedCamp back to DB whenever the live calculation differs from the stored value.
  // This keeps the trip record accurate without requiring a manual save.
  useEffect(() => {
    if (!trip?.stops?.length || !id) return
    const liveCamp = trip.stops.reduce((sum, s) => sum + (s.siteRate || 0) * s.nights, 0)
    if (liveCamp !== (trip.estimatedCamp ?? 0)) {
      tripsApi.update(id, { estimatedCamp: liveCamp }).catch(() => {})
    }
  }, [trip?.id, trip?.stops])

  // Fetch weather via DB-cached endpoint once trip loads
  useEffect(() => {
    if (!trip?.stops?.length || !id) return

    // Mark all coord-having stops as loading
    const initial: Record<string, StopWeather | null | undefined> = {}
    for (const s of trip.stops) {
      if (s.latitude && s.longitude) initial[s.id] = undefined
    }
    setWeatherData(initial)
    setWeatherLoading(true)

    tripsApi.getWeather(id)
      .then(res => {
        setWeatherData(prev => ({ ...prev, ...res.data }))
      })
      .catch(() => {
        // On failure, mark all as null so loading skeletons clear
        setWeatherData(prev => {
          const next = { ...prev }
          for (const k of Object.keys(next)) if (next[k] === undefined) next[k] = null
          return next
        })
      })
      .finally(() => setWeatherLoading(false))
  }, [trip?.id])

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="w-6 h-6 border-2 border-[#1D9E75] border-t-transparent rounded-full animate-spin" />
    </div>
  )
  if (!trip) return <div className="text-center py-20 text-gray-500">Trip not found</div>

  // Always calculate camping cost live from stops (siteRate × nights) — same logic as
  // Full Itinerary page — so both pages always agree.
  const totalCamp   = (trip.stops || []).reduce((sum, s) => sum + (s.siteRate || 0) * s.nights, 0)
  const totalCost   = totalCamp + (trip.estimatedFuel || 0)
  const bookedStops = trip.stops?.filter(s => s.bookingStatus === 'CONFIRMED').length || 0
  const totalStops  = trip.stops?.length || 0

  // Alert count across all stops — for Weather tab badge
  const totalAlerts = Object.values(weatherData).reduce<number>((sum, w) => {
    if (!w || w.mode !== 'live') return sum
    const unique = (w as LiveForecast).days.flatMap(d => d.alerts).filter(
      (a, i, arr) => arr.findIndex(x => x.type === a.type) === i
    )
    return sum + unique.length
  }, 0)

  return (
    <div className="space-y-4 max-w-3xl">
      <Breadcrumb items={[
        { label: 'My Trips', href: '/trips' },
        { label: trip.name },
      ]} />

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
          { label: 'Miles',     value: trip.totalMiles?.toLocaleString() || '–', icon: Map },
          { label: 'Nights',    value: String(trip.totalNights || '–'),           icon: Tent },
          { label: 'Est. cost', value: totalCost ? `$${totalCost.toLocaleString()}` : '–', icon: DollarSign },
          { label: 'Booked',    value: `${bookedStops}/${totalStops}`,            icon: CheckCircle },
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
        <Link to={`/trips/${id}/journal`}   className="btn-ghost text-sm flex items-center gap-1.5"><BookOpen size={14} /> Journal</Link>
        <Link to={`/packing/${id}`}          className="btn-ghost text-sm flex items-center gap-1.5"><Package  size={14} /> Packing list</Link>
        <button className="btn-ghost text-sm flex items-center gap-1.5"><Share2   size={14} /> Share</button>
        <button className="btn-ghost text-sm flex items-center gap-1.5"><Download size={14} /> PDF</button>
      </div>

      {/* Tabs */}
      <div>
        <div className="flex gap-1 border-b border-gray-200 mb-4">
          <button
            onClick={() => setTab('stops')}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === 'stops'
                ? 'border-[#1D9E75] text-[#1D9E75]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Stops ({totalStops})
          </button>
          <button
            onClick={() => setTab('weather')}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
              tab === 'weather'
                ? 'border-[#1D9E75] text-[#1D9E75]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <CloudRain size={13} />
            Weather
            {totalAlerts > 0 && (
              <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {totalAlerts}
              </span>
            )}
          </button>
        </div>

        {tab === 'stops' && (
          trip.stops?.length === 0 ? (
            <div className="card text-center py-8 text-sm text-gray-500">
              No stops yet — <Link to={`/trips/${id}/map`} className="text-[#1D9E75]">add stops on the map</Link>
            </div>
          ) : (
            <div className="space-y-2">
              {trip.stops?.sort((a, b) => a.order - b.order).map((stop, idx, arr) => {
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
          )
        )}

        {tab === 'weather' && (
          <WeatherTab trip={trip} weatherData={weatherData} loading={weatherLoading} />
        )}
      </div>
    </div>
  )
}
