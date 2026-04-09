import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { GoogleMap, useJsApiLoader, Marker, Polyline, InfoWindow, Circle } from '@react-google-maps/api'
import { Layers, MapPin, X, Plus, Minus, Tent, DollarSign, Calendar, AlertTriangle, Wind, Droplets, Snowflake, Thermometer, ExternalLink } from 'lucide-react'
import { tripsApi, weatherApi } from '../../services/api'
import { Trip, Stop, StopWeather, LiveForecast } from '../../types'

const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' }

const PIN_COLORS: Record<string, string> = {
  booked:       '#1D9E75',
  pending:      '#EF9F27',
  notBooked:    '#888780',
  overnight:    '#7F77DD',
  incompatible: '#E24B4A',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + n)
  return isoDateStr(d)
}

function stopHasAlerts(weather: StopWeather | null | undefined): boolean {
  if (!weather || weather.mode !== 'live') return false
  return (weather as LiveForecast).days.some(d => d.alerts.length > 0)
}

function stopAlerts(weather: StopWeather | null | undefined) {
  if (!weather || weather.mode !== 'live') return []
  const all = (weather as LiveForecast).days.flatMap(d => d.alerts)
  return all.filter((a, i, arr) => arr.findIndex(x => x.type === a.type) === i)
}

const ALERT_ICONS: Record<string, JSX.Element> = {
  wind:   <Wind        size={11} className="flex-shrink-0" />,
  rain:   <Droplets    size={11} className="flex-shrink-0" />,
  freeze: <Thermometer size={11} className="flex-shrink-0" />,
  snow:   <Snowflake   size={11} className="flex-shrink-0" />,
}
const ALERT_COLORS: Record<string, string> = {
  amber: 'bg-amber-50 border-amber-200 text-amber-800',
  blue:  'bg-blue-50 border-blue-200 text-blue-800',
  red:   'bg-red-50 border-red-200 text-red-800',
}

// ─── Stop popup ───────────────────────────────────────────────────────────────

function StopPopup({
  stop,
  weather,
  onClose,
  onUpdateNights,
}: {
  stop: Stop
  weather: StopWeather | null | undefined
  onClose: () => void
  onUpdateNights: (id: string, nights: number) => void
}) {
  const alerts  = stopAlerts(weather)
  const nwsUrl = stop.latitude && stop.longitude
    ? `https://forecast.weather.gov/MapClick.php?lat=${stop.latitude}&lon=${stop.longitude}`
    : null

  // Summary line for live or historical
  let weatherSummary: React.ReactNode = null
  if (weather?.mode === 'live') {
    const today = (weather as LiveForecast).days[0]
    if (today) {
      weatherSummary = (
        <div className="flex items-center gap-2 text-xs text-gray-600 mb-2 bg-green-50 rounded px-2 py-1.5 border border-green-100">
          <span className="text-base leading-none">{today.icon}</span>
          <span>{today.high}° / {today.low}°  ·  {today.conditions}</span>
          {nwsUrl && (
            <a href={nwsUrl} target="_blank" rel="noreferrer" className="ml-auto text-[#1D9E75] hover:underline flex-shrink-0">
              <ExternalLink size={10} />
            </a>
          )}
        </div>
      )
    }
  } else if (weather?.mode === 'historical') {
    const h = weather as any
    weatherSummary = (
      <div className="flex items-center gap-2 text-xs text-gray-600 mb-2 bg-blue-50 rounded px-2 py-1.5 border border-blue-100">
        <span className="text-base leading-none">{h.icon}</span>
        <span className="text-[10px] text-blue-500 mr-1">(avg)</span>
        <span>{h.avgHigh}° / {h.avgLow}°  ·  {h.conditions}</span>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 w-72" style={{ borderWidth: '0.5px' }}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <p className="font-medium text-sm text-gray-900">
            {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
          </p>
          <span className={`badge text-xs mt-0.5 ${stop.type === 'OVERNIGHT_ONLY' ? 'badge-purple' : 'badge-green'}`}>
            {stop.type === 'OVERNIGHT_ONLY' ? 'Overnight only' : 'Destination'}
          </span>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X size={14} /></button>
      </div>

      {stop.campgroundName && <p className="text-xs text-gray-500 mb-2">{stop.campgroundName}</p>}

      {!stop.isCompatible && (
        <div className="bg-red-50 text-red-700 text-xs rounded px-2 py-1 mb-2 flex items-center gap-1">
          <AlertTriangle size={12} />
          {stop.incompatibilityReasons?.join(', ')}
        </div>
      )}

      {/* Weather summary + alerts */}
      {weatherSummary}
      {alerts.length > 0 && (
        <div className="space-y-1 mb-2">
          {alerts.map((a, i) => (
            <div key={i} className={`flex items-center gap-1.5 border rounded px-2 py-1 text-xs ${ALERT_COLORS[a.level]}`}>
              {ALERT_ICONS[a.type]}
              {a.message}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-gray-500">Nights</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onUpdateNights(stop.id, stop.nights - 1)}
            disabled={stop.nights <= 1}
            className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 disabled:opacity-30"
          >
            <Minus size={12} />
          </button>
          <span className="text-sm font-medium w-4 text-center">{stop.nights}</span>
          <button
            onClick={() => onUpdateNights(stop.id, stop.nights + 1)}
            className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50"
          >
            <Plus size={12} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
        {stop.siteRate   && <span className="flex items-center gap-1"><DollarSign size={11} />${stop.siteRate}/night</span>}
        {stop.arrivalDate && <span className="flex items-center gap-1"><Calendar   size={11} />{new Date(stop.arrivalDate).toLocaleDateString()}</span>}
        {stop.hookupType  && <span className="badge-green">{stop.hookupType}</span>}
        {stop.isPetFriendly && <span className="text-[#1D9E75]">🐾 Pet-friendly</span>}
      </div>

      {stop.bookingStatus !== 'CONFIRMED' && (
        <a href={`/trips/${stop.tripId}/booking`} className="btn-primary w-full mt-3 text-center text-xs block">
          Reserve campground
        </a>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TripMapPage() {
  const { id } = useParams<{ id: string }>()
  const [trip, setTrip]           = useState<Trip | null>(null)
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null)
  const [sidebarOpen, setSidebarOpen]   = useState(true)
  const [layers, setLayers] = useState({ route: true, stops: true, overnight: true, incompatible: true })
  const [weatherData, setWeatherData] = useState<Record<string, StopWeather | null | undefined>>({})

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
  })

  useEffect(() => {
    if (!id) return
    tripsApi.get(id).then(res => setTrip(res.data))
  }, [id])

  // Fetch weather for stops once trip loads
  useEffect(() => {
    if (!trip?.stops?.length) return

    const today        = new Date()
    const tripStart    = trip.startDate ? new Date(trip.startDate) : null
    const daysUntil    = tripStart
      ? Math.ceil((tripStart.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
      : null
    const useLive = daysUntil !== null && daysUntil <= 10

    const stopsWithCoords = trip.stops.filter(s => s.latitude && s.longitude)

    Promise.all(
      stopsWithCoords.map(async (stop) => {
        try {
          if (useLive && stop.arrivalDate) {
            const startDate = stop.arrivalDate.split('T')[0]
            const endDate   = addDays(startDate, stop.nights)
            const res = await weatherApi.forecast({
              lat: stop.latitude!, lng: stop.longitude!,
              start_date: startDate, end_date: endDate,
            })
            return { id: stop.id, data: res.data as StopWeather }
          } else if (!useLive && stop.arrivalDate) {
            const d = new Date(stop.arrivalDate)
            const res = await weatherApi.historical({
              lat: stop.latitude!, lng: stop.longitude!,
              month: d.getMonth() + 1, day: d.getDate(), days: stop.nights || 1,
            })
            return { id: stop.id, data: res.data as StopWeather }
          }
          return { id: stop.id, data: null }
        } catch {
          return { id: stop.id, data: null }
        }
      })
    ).then(results => {
      const map: Record<string, StopWeather | null> = {}
      for (const r of results) map[r.id] = r.data
      setWeatherData(map)
    })
  }, [trip?.id])

  async function handleUpdateNights(stopId: string, nights: number) {
    if (!id || nights < 1) return
    await tripsApi.updateStop(id, stopId, { nights })
    setTrip(prev => prev ? {
      ...prev,
      stops: prev.stops?.map(s => s.id === stopId ? { ...s, nights } : s),
    } : prev)
    setSelectedStop(prev => prev?.id === stopId ? { ...prev, nights } : prev)
  }

  const center = trip?.stops?.[0]?.latitude
    ? { lat: trip.stops[0].latitude!, lng: trip.stops[0].longitude! }
    : { lat: 39.5, lng: -98.35 }

  const routeCoords = trip?.stops
    ?.filter(s => s.latitude && s.longitude)
    .sort((a, b) => a.order - b.order)
    .map(s => ({ lat: s.latitude!, lng: s.longitude! })) || []

  const getMarkerColor = (stop: Stop) => {
    if (!stop.isCompatible)               return PIN_COLORS.incompatible
    if (stop.type === 'OVERNIGHT_ONLY')   return PIN_COLORS.overnight
    if (stop.bookingStatus === 'CONFIRMED') return PIN_COLORS.booked
    if (stop.bookingStatus === 'PENDING')   return PIN_COLORS.pending
    return PIN_COLORS.notBooked
  }

  return (
    <div className="-mx-4 -my-6 h-[calc(100vh-3.5rem)] flex">
      {/* Sidebar */}
      {sidebarOpen && (
        <div className="w-72 bg-white border-r border-gray-200 flex flex-col overflow-hidden z-10" style={{ borderRightWidth: '0.5px' }}>
          <div className="p-4 border-b border-gray-100" style={{ borderBottomWidth: '0.5px' }}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-medium text-gray-900 text-sm">{trip?.name}</h2>
              <button onClick={() => setSidebarOpen(false)} className="p-1 hover:bg-gray-100 rounded">
                <X size={16} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
              <span className="flex items-center gap-1"><MapPin size={11} />{trip?.totalMiles?.toLocaleString()} mi</span>
              <span className="flex items-center gap-1"><Tent   size={11} />{trip?.totalNights} nights</span>
              {trip?.estimatedFuel && <span className="flex items-center gap-1"><DollarSign size={11} />Fuel ~${trip.estimatedFuel.toLocaleString()}</span>}
              {trip?.estimatedCamp && <span className="flex items-center gap-1"><Tent       size={11} />Camp ~${trip.estimatedCamp.toLocaleString()}</span>}
            </div>
          </div>

          {/* Layer toggles */}
          <div className="p-3 border-b border-gray-100" style={{ borderBottomWidth: '0.5px' }}>
            <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1">
              <Layers size={12} /> Layers
            </p>
            <div className="space-y-1">
              {Object.entries(layers).map(([key, val]) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={val} onChange={() => setLayers(l => ({ ...l, [key]: !val }))} className="rounded" />
                  <span className="text-xs text-gray-600 capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Stop list */}
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            {trip?.stops?.sort((a, b) => a.order - b.order).map(stop => {
              const hasAlert = stopHasAlerts(weatherData[stop.id])
              const alerts   = stopAlerts(weatherData[stop.id])
              return (
                <button
                  key={stop.id}
                  onClick={() => setSelectedStop(stop)}
                  className="w-full text-left flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs flex-shrink-0"
                    style={{ backgroundColor: getMarkerColor(stop) }}
                  >
                    {stop.order}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-900 truncate">{stop.locationName}</p>
                    <p className="text-xs text-gray-400">{stop.nights}n</p>
                  </div>
                  {/* Weather alert badge */}
                  {hasAlert && (
                    <span className="flex items-center gap-0.5 text-[10px] font-medium text-purple-600 flex-shrink-0">
                      <span>🟣</span>{alerts.length}
                    </span>
                  )}
                  {!stop.isCompatible && <AlertTriangle size={12} className="text-red-400 flex-shrink-0" />}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Map */}
      <div className="flex-1 relative">
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="absolute top-3 left-3 z-10 bg-white rounded-lg p-2 border border-gray-200 hover:bg-gray-50"
          >
            <Layers size={16} />
          </button>
        )}

        {isLoaded && trip ? (
          <GoogleMap
            mapContainerStyle={MAP_CONTAINER_STYLE}
            zoom={6}
            center={center}
            options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false }}
          >
            {/* Route polyline */}
            {layers.route && routeCoords.length > 1 && (
              <Polyline
                path={routeCoords}
                options={{ strokeColor: '#1D9E75', strokeWeight: 2, strokeOpacity: 0.8 }}
              />
            )}

            {/* Weather alert circles (purple ellipse) for stops with active alerts */}
            {trip.stops?.filter(s => s.latitude && s.longitude).map(stop => {
              if (!stopHasAlerts(weatherData[stop.id])) return null
              return (
                <Circle
                  key={`weather-alert-${stop.id}`}
                  center={{ lat: stop.latitude!, lng: stop.longitude! }}
                  radius={9000}
                  options={{
                    fillColor:    '#7F77DD',
                    fillOpacity:  0.18,
                    strokeColor:  '#7F77DD',
                    strokeWeight: 1.5,
                    strokeOpacity: 0.55,
                  }}
                />
              )
            })}

            {/* Stop markers */}
            {trip.stops?.filter(s => s.latitude && s.longitude).map(stop => {
              if (!layers.stops      && stop.type !== 'OVERNIGHT_ONLY') return null
              if (!layers.overnight  && stop.type === 'OVERNIGHT_ONLY') return null
              if (!layers.incompatible && !stop.isCompatible)           return null

              return (
                <Marker
                  key={stop.id}
                  position={{ lat: stop.latitude!, lng: stop.longitude! }}
                  label={{ text: String(stop.order), color: 'white', fontSize: '11px', fontWeight: '500' }}
                  onClick={() => setSelectedStop(stop)}
                  icon={{
                    path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z',
                    fillColor:   getMarkerColor(stop),
                    fillOpacity: 1,
                    strokeColor: 'white',
                    strokeWeight: 1.5,
                    scale: 1.5,
                    anchor: new window.google.maps.Point(12, 24),
                  }}
                />
              )
            })}

            {/* Stop popup */}
            {selectedStop && selectedStop.latitude && selectedStop.longitude && (
              <InfoWindow
                position={{ lat: selectedStop.latitude, lng: selectedStop.longitude }}
                onCloseClick={() => setSelectedStop(null)}
              >
                <StopPopup
                  stop={selectedStop}
                  weather={weatherData[selectedStop.id]}
                  onClose={() => setSelectedStop(null)}
                  onUpdateNights={handleUpdateNights}
                />
              </InfoWindow>
            )}
          </GoogleMap>
        ) : (
          <div className="h-full flex items-center justify-center bg-gray-100 text-sm text-gray-500">
            {!isLoaded ? 'Loading map...' : 'No trip data'}
          </div>
        )}
      </div>
    </div>
  )
}
