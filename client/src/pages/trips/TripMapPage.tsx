import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { GoogleMap, useJsApiLoader, InfoWindow, Circle, Polyline } from '@react-google-maps/api'
import {
  Layers, X, Plus, Minus, DollarSign, Calendar, AlertTriangle,
  Wind, Droplets, Snowflake, Thermometer, ExternalLink,
  Pencil, Check, BookOpen, Package, Share2, Download, CheckCircle, Clock, XCircle, CloudRain, Wand2,
  Maximize2, Minimize2, Play,
} from 'lucide-react'
import { pdf } from '@react-pdf/renderer'
import { TripPDF } from '../../components/pdf/TripPDF'
import { format } from 'date-fns'
import { tripsApi } from '../../services/api'
import { Trip, Stop, StopWeather, LiveForecast } from '../../types'
import { StopWeatherCard, ALERT_STYLES } from '../../components/weather/StopWeatherCard'
const ModifyTripPanel = lazy(() => import('../../components/trip/ModifyTripPanel'))
import ConfirmModal from '../../components/ui/ConfirmModal'
import { useAuthStore } from '../../store/authStore'
import { buildStopBadges } from '../../utils/stopBadge'

const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' }
const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

// ─── Marker colors ──────────────────────────────────────────────────────────────
const MC = {
  home:     '#F97316', // orange – home / start (unnumbered dot)
  booked:   '#3E5540', // pine – confirmed
  pending:  '#EF9F27', // amber – pending
  unbooked: '#888780', // gray  – not booked
}

type MarkerKind = 'home' | 'booked' | 'pending' | 'unbooked'

const KIND_COLOR: Record<MarkerKind, string> = {
  home: MC.home, booked: MC.booked, pending: MC.pending, unbooked: MC.unbooked,
}
const KIND_Z: Record<MarkerKind, number> = {
  home: 100, booked: 50, pending: 40, unbooked: 30,
}

// ─── Haversine distance ──────────────────────────────────────────────────────────
function haversineMiles(lat1?: number, lng1?: number, lat2?: number, lng2?: number): number {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 0
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}

// ─── Marker helpers ──────────────────────────────────────────────────────────────

const COORD_TOLERANCE = 0.0001 // ~10 m — tolerates minor float rounding from DB round-trips

function coordsMatch(lat1?: number | null, lng1?: number | null, lat2?: number | null, lng2?: number | null): boolean {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return false
  return Math.abs(lat1 - lat2) < COORD_TOLERANCE && Math.abs(lng1 - lng2) < COORD_TOLERANCE
}

/** Creates the HTML element used as the AdvancedMarkerElement content. */
function makeMarkerContent(kind: MarkerKind, badge: string | number | undefined): HTMLElement {
  const div = document.createElement('div')
  const text = badge != null ? String(badge) : ''
  const fontSize = text.length > 2 ? '8px' : '11px'
  div.style.cssText = `width:26px;height:26px;border-radius:50%;background:${KIND_COLOR[kind]};border:3px solid white;display:flex;align-items:center;justify-content:center;color:white;font-size:${fontSize};font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:pointer;letter-spacing:-0.5px`
  div.textContent = text
  return div
}

/**
 * Formats a Routes API duration string (e.g. "12600s") into a friendly label
 * like "3h 30min" or "45 min".
 */
function formatDuration(durationStr: string): string {
  const seconds = parseInt(durationStr.replace('s', ''), 10)
  if (isNaN(seconds) || seconds <= 0) return ''
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}min`
}

/**
 * Extracts ordered highway names from Routes API leg steps.
 * Each step's navigationInstruction.instructions is plain text like "Merge onto I-17 N".
 */
function parseHighwaysFromRouteSteps(steps: any[], segmentLabel: string): string {
  console.log(`[parseHighways] ${segmentLabel}: ${steps.length} steps`)
  const highways: string[] = []
  const DIR_MAP: Record<string, string> = { N: 'North', S: 'South', E: 'East', W: 'West' }
  for (const step of steps) {
    const text: string = step.navigationInstruction?.instructions || ''
    if (text) console.log(`  step instruction: "${text}"`)
    const hwMatch = text.match(/\b(I-\d+|US-\d+|SR-\d+|[A-Z]{2,3}-\d+)\s*([NSEW])?\b/i)
    if (!hwMatch) continue
    const hwName = hwMatch[1].toUpperCase()
    const dirChar = hwMatch[2]?.toUpperCase()
    let direction = dirChar ? DIR_MAP[dirChar] : null
    if (!direction) {
      const lower = text.toLowerCase()
      if (lower.includes('north')) direction = 'North'
      else if (lower.includes('south')) direction = 'South'
      else if (lower.includes('east')) direction = 'East'
      else if (lower.includes('west')) direction = 'West'
    }
    const formatted = direction ? `${hwName} ${direction}` : hwName
    if (highways.length === 0 || highways[highways.length - 1] !== formatted) highways.push(formatted)
  }
  const result = highways.join(' → ')
  console.log(`[parseHighways] ${segmentLabel} → result: "${result}"`)
  return result
}

// ─── Stop classification ────────────────────────────────────────────────────────
function classifyStop(stop: Stop): MarkerKind {
  if (stop.type === 'HOME')               return 'home'
  if (stop.bookingStatus === 'CONFIRMED') return 'booked'
  if (stop.bookingStatus === 'PENDING')   return 'pending'
  return 'unbooked'
}

// ─── Helpers ────────────────────────────────────────────────────────────────────
function stopHasAlerts(w: StopWeather | null | undefined): boolean {
  return !!w && w.mode === 'live' && (w as LiveForecast).days.some(d => d.alerts.length > 0)
}
function stopAlerts(w: StopWeather | null | undefined) {
  if (!w || w.mode !== 'live') return []
  const all = (w as LiveForecast).days.flatMap(d => d.alerts)
  return all.filter((a, i, arr) => arr.findIndex(x => x.type === a.type) === i)
}

const ALERT_ICONS: Record<string, JSX.Element> = {
  wind:   <Wind size={11} className="flex-shrink-0" />,
  rain:   <Droplets size={11} className="flex-shrink-0" />,
  freeze: <Thermometer size={11} className="flex-shrink-0" />,
  snow:   <Snowflake size={11} className="flex-shrink-0" />,
}
const ALERT_COLORS: Record<string, string> = {
  amber: 'bg-amber-50 border-amber-200 text-amber-800',
  blue:  'bg-blue-50 border-blue-200 text-blue-800',
  red:   'bg-red-50 border-red-200 text-red-800',
}

// ─── Map legend ──────────────────────────────────────────────────────────────────
function MapLegend() {
  return (
    <div className="absolute bottom-6 left-4 bg-white rounded-xl border border-gray-200 px-3 py-2.5 shadow-md z-10" style={{ borderWidth: '0.5px' }}>
      <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Legend</p>
      <div className="space-y-1.5">
        {[
          { letter: 'S', color: MC.home,     label: 'Start' },
          { letter: 'H', color: MC.home,     label: 'Home / Finish' },
          { letter: 'F', color: MC.unbooked, label: 'Finish' },
        ].map(({ letter, color, label }) => (
          <div key={letter} className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full flex items-center justify-center text-white text-[8px] font-bold flex-shrink-0" style={{ backgroundColor: color }}>{letter}</div>
            <span className="text-[11px] text-gray-600 leading-none">{label}</span>
          </div>
        ))}
        {/* Numbered stops */}
        {[
          { color: MC.booked,   label: 'Booked' },
          { color: MC.pending,  label: 'Pending' },
          { color: MC.unbooked, label: 'Not booked' },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
            <span className="text-[11px] text-gray-600 leading-none">{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Stop info popup ─────────────────────────────────────────────────────────────
const BOOKING_BADGE: Record<MarkerKind, { cls: string; label: string }> = {
  home:     { cls: 'bg-slate-100 text-slate-600', label: 'Home' },
  booked:   { cls: 'bg-[#DCE5D5] text-[#2F4030]', label: 'Confirmed' },
  pending:  { cls: 'bg-amber-100 text-amber-700', label: 'Pending' },
  unbooked: { cls: 'bg-gray-100 text-gray-500',   label: 'Not booked' },
}

function StopPopup({
  stop, kind, weather, displayNum, onClose, onUpdateNights,
}: {
  stop: Stop
  kind: MarkerKind
  weather: StopWeather | null | undefined
  displayNum?: 'S' | 'H' | 'F' | 'S/H' | number
  onClose: () => void
  onUpdateNights: (id: string, nights: number) => void
}) {
  const badge  = BOOKING_BADGE[kind]
  const alerts = stopAlerts(weather)
  const nwsUrl = stop.latitude && stop.longitude
    ? `https://forecast.weather.gov/MapClick.php?lat=${stop.latitude}&lon=${stop.longitude}`
    : null

  let weatherSummary: React.ReactNode = null
  if (weather?.mode === 'live') {
    const today = (weather as LiveForecast).days[0]
    if (today) weatherSummary = (
      <div className="flex items-center gap-2 text-xs text-gray-600 mb-2 bg-gray-100 rounded px-2 py-1.5 border border-gray-200">
        <span className="text-base leading-none">{today.icon}</span>
        <span>{today.high}° / {today.low}° · {today.conditions}</span>
        {nwsUrl && (
          <a href={nwsUrl} target="_blank" rel="noreferrer" className="ml-auto text-[#1E3A8A] hover:underline flex-shrink-0">
            <ExternalLink size={10} />
          </a>
        )}
      </div>
    )
  } else if (weather?.mode === 'historical') {
    const h = weather as any
    weatherSummary = (
      <div className="flex items-center gap-2 text-xs text-gray-600 mb-2 bg-blue-50 rounded px-2 py-1.5 border border-blue-100">
        <span className="text-base leading-none">{h.icon}</span>
        <span className="text-[10px] text-blue-500 mr-1">(avg)</span>
        <span>{h.avgHigh}° / {h.avgLow}° · {h.conditions}</span>
      </div>
    )
  }

  return (
    <div className="bg-white p-4 w-72">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
            {displayNum === 'S/H' ? 'Start · Home' : displayNum === 'S' ? 'Start' : displayNum === 'H' ? 'Home · Finish' : displayNum === 'F' ? 'Finish' : `Stop ${displayNum}`}
          </span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded ml-2"><X size={14} /></button>
      </div>

      <p className="font-semibold text-sm text-gray-900 leading-snug">
        {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
      </p>

      {stop.campgroundName && (
        <p className="text-xs text-gray-500 mt-0.5 mb-1">{stop.campgroundName}</p>
      )}

      {!stop.isCompatible && (
        <div className="bg-red-50 text-red-700 text-xs rounded px-2 py-1 mt-1 mb-1 flex items-center gap-1">
          <AlertTriangle size={11} />{stop.incompatibilityReasons?.join(', ')}
        </div>
      )}

      {(weatherSummary || alerts.length > 0) && (
        <div className="mt-2">
          {weatherSummary}
          {alerts.length > 0 && (
            <div className="space-y-1 mb-1">
              {alerts.map((a, i) => (
                <div key={i} className={`flex items-center gap-1.5 border rounded px-2 py-1 text-xs ${ALERT_COLORS[a.level]}`}>
                  {ALERT_ICONS[a.type]}{a.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 mt-2 pt-2 border-t border-gray-100">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">Nights</span>
          <button
            onClick={() => onUpdateNights(stop.id, stop.nights - 1)}
            disabled={stop.nights <= 1}
            className="w-5 h-5 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 disabled:opacity-30"
          ><Minus size={10} /></button>
          <span className="text-sm font-semibold w-4 text-center">{stop.nights}</span>
          <button
            onClick={() => onUpdateNights(stop.id, stop.nights + 1)}
            className="w-5 h-5 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50"
          ><Plus size={10} /></button>
        </div>
        {stop.siteRate && (
          <span className="ml-auto text-xs text-gray-500 flex items-center gap-0.5">
            <DollarSign size={11} />${stop.siteRate}/night
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mt-1.5 text-xs text-gray-400">
        {stop.arrivalDate && (
          <span className="flex items-center gap-0.5"><Calendar size={10} />{new Date(stop.arrivalDate).toLocaleDateString()}</span>
        )}
        {stop.hookupType && <span className="badge-green text-[10px]">{stop.hookupType}</span>}
        {stop.isPetFriendly && <span className="text-[#0F766E]">🐾 Pet-friendly</span>}
      </div>

      {stop.bookingStatus !== 'CONFIRMED' && stop.type !== 'HOME' && (
        <a href={`/trips/${stop.tripId}/booking`} className="btn-primary w-full mt-3 text-center text-xs block">
          Book this stop!
        </a>
      )}
    </div>
  )
}

// ─── Sidebar weather tab ─────────────────────────────────────────────────────────
function SidebarWeatherTab({ trip, weatherData, loading }: {
  trip: Trip
  weatherData: Record<string, StopWeather | null | undefined>
  loading: boolean
}) {
  const nonHomeStops = (trip.stops || [])
    .filter(s => s.type !== 'HOME')
    .sort((a, b) => a.order - b.order)

  const allAlerts = nonHomeStops.flatMap(stop => {
    const w = weatherData[stop.id]
    if (!w || w.mode !== 'live') return []
    return (w as LiveForecast).days.flatMap(d => d.alerts).map(a => ({ ...a, stopName: stop.locationName }))
  })
  const uniqueAlertTypes = allAlerts.filter(
    (a, i, arr) => arr.findIndex(x => x.type === a.type) === i
  )

  if (nonHomeStops.length === 0) {
    return <p className="text-xs text-gray-500 text-center py-6">No stops added yet.</p>
  }

  const hasAnyData = Object.keys(weatherData).length > 0

  return (
    <div className="space-y-3">
      {loading && !hasAnyData && (
        <div className="flex items-center gap-2 text-xs text-gray-500 py-3">
          <div className="w-3 h-3 border-2 border-[#1E3A8A] border-t-transparent rounded-full animate-spin" />
          Loading weather…
        </div>
      )}

      {/* Route weather alerts summary */}
      {uniqueAlertTypes.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-[10px] font-semibold text-amber-800 mb-1.5 flex items-center gap-1">
            <AlertTriangle size={11} /> Weather alerts along this route
          </p>
          <div className="space-y-1">
            {uniqueAlertTypes.map((alert, i) => (
              <div key={i} className={`flex items-center gap-1.5 border rounded px-2 py-1 text-[10px] ${ALERT_STYLES[alert.level]}`}>
                {ALERT_ICONS[alert.type]}
                <span>{alert.message}</span>
                <span className="ml-auto opacity-70 flex-shrink-0">at {alert.stopName}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-stop weather */}
      {nonHomeStops.map((stop, idx) => {
        const hasCoords = !!(stop.latitude && stop.longitude)
        const w = weatherData[stop.id]
        const fetchDone = hasAnyData && !loading
        return (
          <div key={stop.id}>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-4 h-4 rounded-full bg-[#1E3A8A] flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
                {idx + 1}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-900 truncate">
                  {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
                </p>
              </div>
              {stop.arrivalDate && (
                <span className="text-[10px] text-gray-400 flex-shrink-0">
                  {format(new Date(stop.arrivalDate), 'MMM d')}
                </span>
              )}
            </div>
            {!hasCoords ? (
              <p className="text-[10px] text-gray-400 italic ml-6">No coordinates — geocode via map.</p>
            ) : fetchDone && w === undefined ? (
              <p className="text-[10px] text-gray-400 italic ml-6">Weather unavailable.</p>
            ) : (
              <StopWeatherCard stop={stop} weather={w} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────────
export default function TripMapPage() {
  const { user } = useAuthStore()
  const { id } = useParams<{ id: string }>()
  const [trip, setTrip]                     = useState<Trip | null>(null)
  const [selectedStop, setSelectedStop]     = useState<Stop | null>(null)
  const [sidebarOpen, setSidebarOpen]       = useState(true)
  const [sidebarTab, setSidebarTab]         = useState<'stops' | 'weather'>('stops')
  const [layers, setLayers]                 = useState({ route: true, stops: true, overnight: true, incompatible: true })
  const [weatherData, setWeatherData]       = useState<Record<string, StopWeather | null | undefined>>({})
  const [weatherLoading, setWeatherLoading] = useState(false)
  const [geocoding, setGeocoding]           = useState(false)
  const [routePath, setRoutePath]           = useState<google.maps.LatLng[] | null>(null)
  const [mapInstance, setMapInstance]       = useState<google.maps.Map | null>(null)
  const [renaming, setRenaming]             = useState(false)
  const [tripNameInput, setTripNameInput]   = useState('')
  const [modifyPanelOpen, setModifyPanelOpen] = useState(false)
  const [mapExpanded, setMapExpanded]       = useState(false)
  const [isMobile, setIsMobile]             = useState(() => window.innerWidth < 768)
  const [isDesktop, setIsDesktop]           = useState(() => window.innerWidth >= 1024)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [confirmCompleteOpen, setConfirmCompleteOpen] = useState(false)
  const [changingStatus, setChangingStatus] = useState(false)

  const mapRowRef = useRef<HTMLDivElement>(null)

  // Imperative marker refs — we manage these ourselves via AdvancedMarkerElement
  const markersRef          = useRef<google.maps.marker.AdvancedMarkerElement[]>([])
  const directionsCoordsKey = useRef<string | null>(null)

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES,
  })

  const onMapLoad = useCallback((map: google.maps.Map) => {
    setMapInstance(map)
  }, [])

  // ── Map expand / collapse ─────────────────────────────────────────────────────
  const expandMap = useCallback(() => {
    setMapExpanded(true)
    setSidebarOpen(false)
    document.body.style.overflow = 'hidden'
  }, [])

  const collapseMap = useCallback(() => {
    setMapExpanded(false)
    setSidebarOpen(true)
    document.body.style.overflow = ''
  }, [])

  // Escape key collapses an expanded map; cleanup overflow lock on unmount
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && mapExpanded) collapseMap() }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      if (mapExpanded) document.body.style.overflow = ''
    }
  }, [mapExpanded, collapseMap])

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth
      setIsMobile(w < 768)
      setIsDesktop(w >= 1024)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Notify Google Maps of container resize after the CSS transition ends
  useEffect(() => {
    const t = setTimeout(() => {
      if (mapInstance) window.google.maps.event.trigger(mapInstance, 'resize')
    }, 360) // slightly after the 350ms transition
    return () => clearTimeout(t)
  }, [mapExpanded, mapInstance])

  // ── Load trip ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return
    tripsApi.get(id).then(res => {
      const data = res.data
      console.log('[TripMapPage] trip loaded:', {
        tripId: data.id, tripName: data.name, stopCount: data.stops?.length ?? 0,
        stops: data.stops?.map((s: Stop) => ({
          id: s.id, order: s.order, type: s.type,
          locationName: s.locationName, locationState: s.locationState,
          bookingStatus: s.bookingStatus,
          lat: s.latitude, lng: s.longitude,
          hasCoords: !!(s.latitude && s.longitude),
        })),
      })
      setTrip(data)
      setTripNameInput(data.name)
    })
  }, [id])

  // Refetch trip when window regains focus (e.g. returning from TripBookingPage)
  useEffect(() => {
    if (!id) return
    const refetch = () => {
      tripsApi.get(id).then(res => setTrip(res.data)).catch(err => console.error('Refetch failed', err))
    }
    window.addEventListener('focus', refetch)
    return () => window.removeEventListener('focus', refetch)
  }, [id])

  // ── Weather — use DB-cached endpoint ─────────────────────────────────────────
  useEffect(() => {
    if (!trip?.stops?.length || !id) return
    const initial: Record<string, StopWeather | null | undefined> = {}
    for (const s of trip.stops) {
      if (s.latitude && s.longitude) initial[s.id] = undefined
    }
    setWeatherData(initial)
    setWeatherLoading(true)
    tripsApi.getWeather(id)
      .then(res => setWeatherData(prev => ({ ...prev, ...res.data })))
      .catch(() => {
        setWeatherData(prev => {
          const next = { ...prev }
          for (const k of Object.keys(next)) if (next[k] === undefined) next[k] = null
          return next
        })
      })
      .finally(() => setWeatherLoading(false))
  }, [trip?.id])

  // ── Geocode stops missing lat/lng, save to DB ─────────────────────────────────
  useEffect(() => {
    if (!isLoaded || !id || !trip?.stops?.length || geocoding) return
    const allMissing = trip.stops.filter(s => !s.latitude || !s.longitude)
    if (!allMissing.length) return

    const sortedAll  = trip.stops.slice().sort((a, b) => a.order - b.order)
    const lastStop   = sortedAll[sortedAll.length - 1]
    const hasExactHome = !!(user?.homeLat && user?.homeLng)

    console.log('[TripMapPage:geocodeEffect] allMissing=%d hasExactHome=%s homeLat=%s homeLng=%s homeCity=%s',
      allMissing.length, hasExactHome, user?.homeLat, user?.homeLng, user?.homeCity)
    allMissing.forEach(s => console.log('[TripMapPage:geocodeEffect]   missing stop id=%s type=%s locationName=%s', s.id, s.type, s.locationName))

    // Stops that get the user's exact home coordinates instead of geocoding:
    //   • Any HOME-typed stop
    //   • The last stop when its city matches the user's homeCity (returning home)
    const exactHomeStops = hasExactHome
      ? allMissing.filter(s => {
          if (s.type === 'HOME') return true
          if (s.id === lastStop?.id && user?.homeCity)
            return s.locationName.toLowerCase().trim() === user.homeCity.toLowerCase().trim()
          return false
        })
      : []

    console.log('[TripMapPage:geocodeEffect] exactHomeStops=%d toGeocode=%d',
      exactHomeStops.length, allMissing.length - exactHomeStops.length)

    const exactHomeIds = new Set(exactHomeStops.map(s => s.id))
    const toGeocode    = allMissing.filter(s => !exactHomeIds.has(s.id))

    // Apply exact home coords immediately — fire-and-forget DB saves
    if (exactHomeStops.length) {
      Promise.allSettled(
        exactHomeStops.map(s =>
          tripsApi.updateStop(id, s.id, { latitude: user!.homeLat!, longitude: user!.homeLng! })
        )
      )
      setTrip(prev => prev ? {
        ...prev,
        stops: prev.stops?.map(s =>
          exactHomeIds.has(s.id) ? { ...s, latitude: user!.homeLat!, longitude: user!.homeLng! } : s
        ),
      } : prev)
      console.log('[TripMapPage] applied exact home coords to', exactHomeStops.length, 'stop(s)')
    }

    if (!toGeocode.length) return

    console.log('[TripMapPage] geocoding', toGeocode.length, 'stop(s) missing coordinates')
    setGeocoding(true)
    const geocoder = new window.google.maps.Geocoder()

    Promise.all(toGeocode.map(stop =>
      new Promise<{ stop: Stop; lat: number; lng: number } | null>(resolve => {
        const q = [stop.locationName, stop.locationState, 'USA'].filter(Boolean).join(', ')
        geocoder.geocode({ address: q }, (results, status) => {
          if (status === 'OK' && results?.[0]) {
            const loc = results[0].geometry.location
            console.log('[TripMapPage] geocoded', stop.locationName, '→', loc.lat(), loc.lng())
            resolve({ stop, lat: loc.lat(), lng: loc.lng() })
          } else {
            console.warn('[TripMapPage] geocode failed:', stop.locationName, status)
            resolve(null)
          }
        })
      })
    )).then(async results => {
      const valid = results.filter(Boolean) as { stop: Stop; lat: number; lng: number }[]
      await Promise.allSettled(
        valid.map(({ stop, lat, lng }) => tripsApi.updateStop(id, stop.id, { latitude: lat, longitude: lng }))
      )
      setTrip(prev => prev ? {
        ...prev,
        stops: prev.stops?.map(s => {
          const found = valid.find(r => r.stop.id === s.id)
          return found ? { ...s, latitude: found.lat, longitude: found.lng } : s
        }),
      } : prev)
      setGeocoding(false)
    })
  }, [isLoaded, trip?.id, user?.homeLat, user?.homeLng])

  // ── Pin HOME stops to exact home coordinates ───────────────────────────────────
  // Runs independently of the geocode effect so it also corrects stops that were
  // previously geocoded to city center (non-null coords that are still wrong).
  useEffect(() => {
    if (!id || !trip?.stops?.length || !user?.homeLat || !user?.homeLng) return

    const sortedAll = trip.stops.slice().sort((a, b) => a.order - b.order)
    const lastStop  = sortedAll[sortedAll.length - 1]

    const stopsToPin = trip.stops.filter(s => {
      const isHomeType = s.type === 'HOME'
      const isReturnHome = s.id === lastStop?.id && !!user?.homeCity &&
        s.locationName.toLowerCase().trim() === user.homeCity.toLowerCase().trim()
      if (!isHomeType && !isReturnHome) return false
      return s.latitude !== user.homeLat || s.longitude !== user.homeLng
    })

    if (!stopsToPin.length) return

    console.log('[TripMapPage:homePin] pinning', stopsToPin.length, 'stop(s) to exact home coords', user.homeLat, user.homeLng)
    Promise.allSettled(
      stopsToPin.map(s =>
        tripsApi.updateStop(id, s.id, { latitude: user.homeLat!, longitude: user.homeLng! })
      )
    )
    setTrip(prev => prev ? {
      ...prev,
      stops: prev.stops?.map(s =>
        stopsToPin.find(p => p.id === s.id)
          ? { ...s, latitude: user.homeLat!, longitude: user.homeLng! }
          : s
      ),
    } : prev)
  }, [trip?.id, user?.homeLat, user?.homeLng])

  // ── Routes API (replaces deprecated DirectionsService) ────────────────────────
  useEffect(() => {
    if (!isLoaded || geocoding || !trip?.stops?.length) return
    const coordStops = trip.stops
      .filter(s => s.latitude && s.longitude)
      .sort((a, b) => a.order - b.order)
    if (coordStops.length < 2) return

    const key = coordStops.map(s => `${s.latitude},${s.longitude}`).join('|')
    if (directionsCoordsKey.current === key) return
    directionsCoordsKey.current = key

    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string
    const intermediates = coordStops.slice(1, -1).slice(0, 25).map(s => ({
      location: { latLng: { latitude: s.latitude!, longitude: s.longitude! } },
    }))

    console.log('[TripMapPage] Calling Routes API for', coordStops.length, 'stops, key:', key)

    fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.legs.duration,routes.legs.distanceMeters,routes.legs.steps.navigationInstruction',
      },
      body: JSON.stringify({
        origin:      { location: { latLng: { latitude: coordStops[0].latitude!,                    longitude: coordStops[0].longitude! } } },
        destination: { location: { latLng: { latitude: coordStops[coordStops.length-1].latitude!, longitude: coordStops[coordStops.length-1].longitude! } } },
        intermediates: intermediates.length ? intermediates : undefined,
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
      }),
    })
      .then(r => {
        console.log('[TripMapPage] Routes API HTTP status:', r.status)
        return r.json()
      })
      .then(data => {
        console.log('[TripMapPage] Routes API raw response:', JSON.stringify(data).slice(0, 500))
        const route = data.routes?.[0]
        if (!route) { console.warn('[TripMapPage] Routes API: no route in response', data); return }

        // Decode the overall polyline and draw the route line
        const encoded: string = route.polyline?.encodedPolyline
        console.log('[TripMapPage] encoded polyline length:', encoded?.length ?? 0)
        if (encoded && window.google.maps.geometry?.encoding) {
          setRoutePath(window.google.maps.geometry.encoding.decodePath(encoded))
        }

        // Extract real highway names, durations, and distances per leg; persist to each destination stop
        const legs: any[] = route.legs ?? []
        console.log('[TripMapPage] legs count:', legs.length, '| expected:', coordStops.length - 1)
        let totalDistanceMeters = 0
        legs.forEach((leg, i) => {
          const destStop = coordStops[i + 1]
          if (!destStop || !id) return
          const label = `leg[${i}] → ${destStop.locationName}`
          const highways      = parseHighwaysFromRouteSteps(leg.steps ?? [], label)
          const driveDuration = formatDuration(leg.duration ?? '')
          const distMeters: number = leg.distanceMeters ?? 0
          const driveDistanceMiles = distMeters > 0 ? Math.round(distMeters / 1609.34) : undefined
          totalDistanceMeters += distMeters
          console.log('[TripMapPage]', label, '| highways:', highways || '(none)', '| duration:', driveDuration || '(none)', '| miles:', driveDistanceMiles ?? '(none)')

          // tripsApi.updateStop → api.put('/trips/:id/stops/:stopId') → authenticated axios (Bearer token)
          const stopUpdate: any = {}
          if (highways)           stopUpdate.highwayRoute      = highways
          if (driveDuration)      stopUpdate.driveDuration     = driveDuration
          if (driveDistanceMiles) stopUpdate.driveDistanceMiles = driveDistanceMiles

          if (Object.keys(stopUpdate).length > 0) {
            tripsApi.updateStop(id, destStop.id, stopUpdate)
              .then(res => {
                console.log('[TripMapPage] ✓ updateStop saved for', destStop.locationName,
                  '| highwayRoute:', res.data?.highwayRoute,
                  '| driveDuration:', res.data?.driveDuration,
                  '| driveDistanceMiles:', res.data?.driveDistanceMiles)
              })
              .catch(err => {
                const status = err?.response?.status
                console.error('[TripMapPage] ✗ updateStop FAILED for', destStop.locationName,
                  '| HTTP', status, '|', err?.response?.data || err?.message)
                if (status === 401) console.error('[TripMapPage] 401: restart the dev server to reload auth middleware')
              })
          }

          setTrip(prev => prev ? {
            ...prev,
            stops: prev.stops?.map(s => s.id === destStop.id
              ? {
                  ...s,
                  ...(highways && { highwayRoute: highways }),
                  ...(driveDuration && { driveDuration }),
                  ...(driveDistanceMiles && { driveDistanceMiles }),
                }
              : s),
          } : prev)
        })

        // Sum all leg distances → update trip.totalMiles in DB
        if (totalDistanceMeters > 0 && id) {
          const totalMiles = Math.round(totalDistanceMeters / 1609.34)
          console.log('[TripMapPage] Calculated total miles from Routes API:', totalMiles)
          tripsApi.update(id, { totalMiles })
            .then(() => {
              console.log('[TripMapPage] ✓ trip.totalMiles updated to', totalMiles)
              setTrip(prev => prev ? { ...prev, totalMiles } : prev)
            })
            .catch(err => console.error('[TripMapPage] ✗ Failed to update trip.totalMiles:', err))
        }
      })
      .catch(err => console.warn('[TripMapPage] Routes API fetch error:', err))
  }, [isLoaded, geocoding, trip?.stops])

  // ── Derived values ─────────────────────────────────────────────────────────────
  const stopsWithCoords = useMemo(
    () => trip?.stops?.filter(s => s.latitude && s.longitude).sort((a, b) => a.order - b.order) ?? [],
    [trip?.stops]
  )

  // Badge values: 'S' for first stop, 'H'/'F' for last, sequential numbers for middle stops.
  const stopBadges = useMemo(() => {
    const sorted = trip?.stops?.slice().sort((a, b) => a.order - b.order) ?? []
    return buildStopBadges(sorted, user)
  }, [trip?.stops, user])

  // True when the first and last stops are at the same coordinates AND the last stop
  // is badged 'H' — triggers the combined S/H single marker to avoid invisible stacking.
  const combinedSH = useMemo(() => {
    if (stopsWithCoords.length < 2) return false
    const first = stopsWithCoords[0]
    const last  = stopsWithCoords[stopsWithCoords.length - 1]
    return (
      stopBadges[last.id] === 'H' &&
      coordsMatch(first.latitude, first.longitude, last.latitude, last.longitude)
    )
  }, [stopsWithCoords, stopBadges])

  // Drive segments with per-segment miles (Routes API actual or Haversine fallback)
  const { driveSegments, liveTotalMiles } = useMemo(() => {
    const sorted = [...(trip?.stops || [])].sort((a, b) => a.order - b.order)
    const segments = sorted.slice(1).map((stop, i) => {
      const prev = sorted[i]
      const miles = stop.driveDistanceMiles
        ?? haversineMiles(prev.latitude, prev.longitude, stop.latitude, stop.longitude)
      return { stop, miles }
    })
    const total = segments.reduce((sum, s) => sum + s.miles, 0)
    return { driveSegments: segments, liveTotalMiles: total }
  }, [trip?.stops])

  // Cost and booking stats
  const { totalCost, nonHomeStops, bookedStops } = useMemo(() => {
    const stops = trip?.stops || []
    const camp = stops.reduce((sum, s) => sum + ((s as any).siteRate || 0) * s.nights, 0)
    const nonHome = stops.filter((s: Stop) => s.type !== 'HOME')
    const booked = nonHome.filter(s => s.bookingStatus === 'CONFIRMED').length
    return {
      totalCost: camp + (trip?.estimatedFuel || 0),
      nonHomeStops: nonHome,
      bookedStops: booked,
    }
  }, [trip?.stops, trip?.estimatedFuel])

  // Total unique weather alerts across all stops — for the Weather tab badge
  const totalAlerts = useMemo(() => {
    return Object.values(weatherData).reduce<number>((sum, w) => {
      if (!w || w.mode !== 'live') return sum
      const unique = (w as LiveForecast).days.flatMap(d => d.alerts).filter(
        (a, i, arr) => arr.findIndex(x => x.type === a.type) === i
      )
      return sum + unique.length
    }, 0)
  }, [weatherData])

  // ── Imperative markers ─────────────────────────────────────────────────────────
  useEffect(() => {
    markersRef.current.forEach(m => { m.map = null })
    markersRef.current = []

    if (!mapInstance || !stopsWithCoords.length) return

    console.log(`[TripMapPage] placing ${stopsWithCoords.length} marker(s) on map`)

    const firstStop = stopsWithCoords[0]
    const lastStop  = stopsWithCoords[stopsWithCoords.length - 1]

    stopsWithCoords.forEach(stop => {
      const isFirst = stop.id === firstStop?.id
      const isLast  = stop.id === lastStop?.id

      // When start and home-return share the same pin, skip the last stop entirely
      // and give the first stop the combined 'S/H' badge instead.
      if (combinedSH && isLast && !isFirst) return

      const kind  = classifyStop(stop)
      const badge = combinedSH && isFirst ? 'S/H' : stopBadges[stop.id]

      // Layer visibility — HOME (start) always shows
      if (kind !== 'home') {
        if (!layers.stops && stop.type !== 'OVERNIGHT_ONLY') return
        if (!layers.overnight && stop.type === 'OVERNIGHT_ONLY') return
        if (!layers.incompatible && !stop.isCompatible) return
      }

      console.log(
        `[TripMapPage] marker badge=${badge} "${stop.locationName}" kind=${kind}`,
        `lat=${stop.latitude} lng=${stop.longitude}`,
      )

      const marker = new window.google.maps.marker.AdvancedMarkerElement({
        position: { lat: stop.latitude!, lng: stop.longitude! },
        map:      mapInstance,
        content:  makeMarkerContent(kind, badge),
        title:    stop.locationName,
        zIndex:   KIND_Z[kind],
      })
      marker.addListener('click', () => setSelectedStop(stop))
      markersRef.current.push(marker)
    })

    console.log(`[TripMapPage] ${markersRef.current.length} marker(s) added to map`)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInstance, stopsWithCoords, stopBadges, layers])

  // Cleanup markers on unmount
  useEffect(() => () => { markersRef.current.forEach(m => { m.map = null }) }, [])

  // ── Handlers ──────────────────────────────────────────────────────────────────
  async function handleUpdateNights(stopId: string, nights: number) {
    if (!id || nights < 1) return
    await tripsApi.updateStop(id, stopId, { nights })
    setTrip(prev => prev ? { ...prev, stops: prev.stops?.map(s => s.id === stopId ? { ...s, nights } : s) } : prev)
    setSelectedStop(prev => prev?.id === stopId ? { ...prev, nights } : prev)
  }

  async function handleRename() {
    const trimmed = tripNameInput.trim()
    if (!id || !trimmed || trimmed === trip?.name) { setRenaming(false); return }
    await tripsApi.update(id, { name: trimmed }).catch(() => {})
    setTrip(prev => prev ? { ...prev, name: trimmed } : prev)
    setRenaming(false)
  }

  async function handleStartTrip() {
    if (!trip || changingStatus) return
    setChangingStatus(true)
    try {
      const res = await tripsApi.update(trip.id, { status: 'ACTIVE' })
      setTrip(res.data)
    } catch (err) {
      console.error('Failed to start trip', err)
      alert('Could not start trip. Please try again.')
    } finally {
      setChangingStatus(false)
    }
  }

  async function handleMarkCompleted() {
    if (!trip || changingStatus) return
    setChangingStatus(true)
    try {
      const res = await tripsApi.update(trip.id, { status: 'COMPLETED' })
      setTrip(res.data)
      setConfirmCompleteOpen(false)
    } catch (err) {
      console.error('Failed to mark trip completed', err)
      alert('Could not mark trip as completed. Please try again.')
    } finally {
      setChangingStatus(false)
    }
  }

  async function handleExportPdf() {
    if (downloadingPdf || !trip) return
    setDownloadingPdf(true)
    try {
      // Fetch static map image and convert to blob URL
      // (react-pdf v4 uses Buffer to decode data: URLs in the browser — passing a blob URL avoids that)
      let mapBlobUrl: string | null = null
      try {
        const mapRes = await tripsApi.getMapImage(trip.id)
        const dataUrl: string | null = mapRes.data?.base64 ?? null
        if (dataUrl) {
          const fetchRes = await fetch(dataUrl)
          const imgBlob = await fetchRes.blob()
          mapBlobUrl = URL.createObjectURL(imgBlob)
        }
      } catch (mapErr) {
        console.error('[PDF] map image fetch failed:', mapErr)
        // Map image is optional — proceed without it
      }

      const blob = await pdf(<TripPDF trip={trip} mapImageBase64={mapBlobUrl} />).toBlob()
      if (mapBlobUrl) URL.revokeObjectURL(mapBlobUrl)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `RoamReady-${trip.name || 'Trip'}-Itinerary.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('PDF export failed', err)
      alert('PDF generation failed. Please try again.')
    } finally {
      setDownloadingPdf(false)
    }
  }

  const center = stopsWithCoords[0]
    ? { lat: stopsWithCoords[0].latitude!, lng: stopsWithCoords[0].longitude! }
    : { lat: 39.5, lng: -98.35 }

  const colorForStop = (stop: Stop) => KIND_COLOR[classifyStop(stop)]

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="-mx-4 -my-6">

      {/* Breadcrumb strip */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100 px-4 py-2 flex items-center gap-1.5">
        <Link to="/trips" className="text-xs text-[#1E3A8A] hover:text-[#1E40AF] transition-colors">My Trips</Link>
        <span className="text-gray-300 text-xs">›</span>
        <span className="text-xs text-gray-700 font-medium truncate max-w-[200px]">{trip?.name ?? '…'}</span>
      </div>

      {/* Action tab bar — Itinerary, Journal, Packing list, Share, PDF */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100 px-2 flex flex-wrap lg:flex-nowrap items-center gap-0.5">
        <Link
          to={`/trips/${id}/itinerary`}
          className="flex items-center gap-1.5 px-3 py-2 text-xs text-gray-600 hover:text-[#1E3A8A] hover:bg-gray-50 rounded-md transition-colors whitespace-nowrap flex-shrink-0"
        >
          <Calendar size={13} /> Itinerary
        </Link>
        <Link
          to={`/trips/${id}/journal`}
          className="flex items-center gap-1.5 px-3 py-2 text-xs text-gray-600 hover:text-[#1E3A8A] hover:bg-gray-50 rounded-md transition-colors whitespace-nowrap flex-shrink-0"
        >
          <BookOpen size={13} /> Journal
        </Link>
        <Link
          to={`/packing/${id}`}
          className="flex items-center gap-1.5 px-3 py-2 text-xs text-gray-600 hover:text-[#1E3A8A] hover:bg-gray-50 rounded-md transition-colors whitespace-nowrap flex-shrink-0"
        >
          <Package size={13} /> Packing list
        </Link>
        <button className="flex items-center gap-1.5 px-3 py-2 text-xs text-gray-600 hover:text-[#1E3A8A] hover:bg-gray-50 rounded-md transition-colors whitespace-nowrap flex-shrink-0">
          <Share2 size={13} /> Share
        </button>
        <button
          onClick={handleExportPdf}
          disabled={downloadingPdf}
          className="flex items-center gap-1.5 px-3 py-2 text-xs text-gray-600 hover:text-[#1E3A8A] hover:bg-gray-50 rounded-md transition-colors whitespace-nowrap flex-shrink-0 disabled:opacity-50"
        >
          <Download size={13} /> {downloadingPdf ? 'Generating...' : 'PDF'}
        </button>
      </div>

      {/* ── Map + sidebar row ─────────────────────────────────────────────────── */}
      {/* Wrapper provides the reference height that expandMap() reads */}
      <div>
      <div
        ref={mapRowRef}
        className={isMobile ? 'flex flex-col' : 'flex items-start'}
        style={{
          transition: 'height 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >

        {/* ── Sidebar ──────────────────────────────────────────────────────────── */}
        <div
          className="bg-white border-r border-gray-200 z-20"
          style={isMobile ? {
            borderRightWidth: '0.5px',
            width: '100%',
            order: 2,
          } : !isDesktop ? {
            borderRightWidth: '0.5px',
            width: '20rem',
            flexShrink: 0,
          } : {
            borderRightWidth: '0.5px',
            width: (sidebarOpen && !mapExpanded) ? '24rem' : '0',
            overflow: 'hidden',
            transition: 'width 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
            flexShrink: 0,
          }}
        >
            {/* Header: trip name + rename + close */}
            <div className="p-4 border-b border-gray-100 flex-shrink-0" style={{ borderBottomWidth: '0.5px' }}>
              <div className="flex items-start gap-2 mb-3">
                {renaming ? (
                  <div className="flex-1 flex items-center gap-1 min-w-0">
                    <input
                      className="flex-1 min-w-0 text-sm font-medium text-gray-900 border border-[#1E3A8A] rounded px-2 py-1 focus:outline-none"
                      value={tripNameInput}
                      onChange={e => setTripNameInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename()
                        if (e.key === 'Escape') setRenaming(false)
                      }}
                      autoFocus
                    />
                    <button onClick={handleRename} className="p-1 text-[#1E3A8A] hover:bg-[#EFF6FF] rounded flex-shrink-0">
                      <Check size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center gap-1 min-w-0">
                    <h2 className="font-medium text-gray-900 text-sm truncate">{trip?.name}</h2>
                    <button
                      onClick={() => { setTripNameInput(trip?.name || ''); setRenaming(true) }}
                      className="p-1 hover:bg-gray-100 rounded flex-shrink-0"
                      title="Rename trip"
                    >
                      <Pencil size={12} className="text-gray-400" />
                    </button>
                  </div>
                )}
                {isDesktop && (
                  <button onClick={() => setSidebarOpen(false)} className="p-1 hover:bg-gray-100 rounded flex-shrink-0" title="Close sidebar">
                    <X size={16} />
                  </button>
                )}
              </div>

              {/* Status pill — ACTIVE or COMPLETED only */}
              {(trip?.status === 'ACTIVE' || trip?.status === 'COMPLETED') && (
                <div className="mt-1 mb-3">
                  <span className={trip.status === 'ACTIVE' ? 'badge-active' : 'badge-completed'}>
                    {trip.status === 'ACTIVE' ? 'Active' : 'Completed'}
                  </span>
                </div>
              )}

              {/* Action buttons stack */}
              <div className="flex flex-col gap-2 mt-3">
                {/* Booking CTA — hidden if no bookable stops, pine "Booked" if all confirmed, gold "Let's book it!" otherwise */}
                {nonHomeStops.length > 0 && (
                  bookedStops === nonHomeStops.length ? (
                    <div className="bg-[#DCE5D5] text-[#2F4030] text-sm font-medium px-4 py-2.5 rounded-md text-center flex items-center justify-center gap-1.5">
                      <CheckCircle size={14} /> Booked
                    </div>
                  ) : (
                    <Link
                      to={`/trips/${id}/booking`}
                      className="bg-[#F7A829] text-white hover:bg-[#C9851A] active:bg-[#8A5A0E] text-sm font-medium px-4 py-2.5 rounded-md text-center transition-colors"
                    >
                      Let's book it! ›
                    </Link>
                  )
                )}

                {/* Status-dependent middle button */}
                {trip?.status === 'PLANNING' && (
                  <button
                    onClick={handleStartTrip}
                    disabled={changingStatus}
                    className="border border-[#1F6F8B] text-[#1F6F8B] bg-white hover:bg-[#E0F0F4] text-sm font-medium px-4 py-2.5 rounded-md transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <Play size={14} /> {changingStatus ? 'Starting...' : 'Start trip'}
                  </button>
                )}

                {trip?.status === 'ACTIVE' && (
                  <button
                    onClick={() => setConfirmCompleteOpen(true)}
                    disabled={changingStatus}
                    className="border border-[#3E5540] text-[#2F4030] bg-white hover:bg-[#DCE5D5] text-sm font-medium px-4 py-2.5 rounded-md transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <CheckCircle size={14} /> Mark completed
                  </button>
                )}

                {trip?.status === 'COMPLETED' && (
                  <div className="bg-[#DCE5D5] text-[#2F4030] text-sm font-medium px-4 py-2.5 rounded-md text-center flex items-center justify-center gap-1.5">
                    <CheckCircle size={14} /> Trip completed
                  </div>
                )}

                {/* Modify trip with AI */}
                <button
                  onClick={() => setModifyPanelOpen(true)}
                  className="border border-[#1F6F8B] text-[#1F6F8B] bg-white hover:bg-[#E0F0F4] text-sm font-medium px-4 py-2.5 rounded-md transition-colors flex items-center justify-center gap-1.5"
                >
                  <Wand2 size={13} /> Modify trip with AI
                </button>
              </div>

              {/* Stats — 4 across */}
              <div className="grid grid-cols-4 gap-1.5">
                <div className="bg-gray-50 rounded-lg px-2.5 py-2 text-center">
                  <p className="text-[10px] text-gray-400 mb-0.5">Miles</p>
                  <p className="text-sm font-semibold text-gray-900">
                    {liveTotalMiles > 0 ? liveTotalMiles.toLocaleString() : (trip?.totalMiles?.toLocaleString() || '–')}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg px-2.5 py-2 text-center">
                  <p className="text-[10px] text-gray-400 mb-0.5">Nights</p>
                  <p className="text-sm font-semibold text-gray-900">{trip?.totalNights || '–'}</p>
                </div>
                <div className="bg-gray-50 rounded-lg px-2.5 py-2 text-center">
                  <p className="text-[10px] text-gray-400 mb-0.5">Est. cost</p>
                  <p className="text-sm font-semibold text-gray-900">{totalCost ? `$${totalCost.toLocaleString()}` : '–'}</p>
                </div>
                <div className="bg-gray-50 rounded-lg px-2.5 py-2 text-center">
                  <p className="text-[10px] text-gray-400 mb-0.5">Booked</p>
                  <p className="text-sm font-semibold text-gray-900">{bookedStops}/{nonHomeStops.length}</p>
                </div>
              </div>
            </div>

            {/* Miles by segment */}
            {driveSegments.length > 0 && (
              <div className="px-3 py-2.5 border-b border-gray-100 flex-shrink-0" style={{ borderBottomWidth: '0.5px' }}>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Miles by segment</p>
                <div className="space-y-0.5">
                  {driveSegments.map(({ stop, miles }) => (
                    <div key={stop.id} className="flex justify-between text-xs">
                      <span className="text-gray-600 truncate mr-2">{stop.locationName}</span>
                      <span className={`font-medium flex-shrink-0 ${stop.driveDistanceMiles ? 'text-gray-900' : 'text-gray-400'}`}>
                        {miles > 0 ? `${miles.toLocaleString()} mi` : '–'}
                        {!stop.driveDistanceMiles && miles > 0 && (
                          <span className="text-[9px] ml-0.5 opacity-60">est.</span>
                        )}
                      </span>
                    </div>
                  ))}
                  <div className="flex justify-between text-xs font-semibold border-t border-gray-100 pt-1 mt-0.5">
                    <span className="text-gray-700">Total</span>
                    <span className="text-gray-900">{liveTotalMiles > 0 ? `${liveTotalMiles.toLocaleString()} mi` : '–'}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Layer toggles */}
            <div className="px-3 py-2.5 border-b border-gray-100 flex-shrink-0" style={{ borderBottomWidth: '0.5px' }}>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5 flex items-center gap-1">
                <Layers size={11} /> Layers
              </p>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                {Object.entries(layers).map(([key, val]) => (
                  <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={val}
                      onChange={() => setLayers(l => ({ ...l, [key]: !val }))}
                      className="rounded"
                    />
                    <span className="text-xs text-gray-600 capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Stops / Weather tab bar */}
            <div className="flex border-b border-gray-100 flex-shrink-0" style={{ borderBottomWidth: '0.5px' }}>
              <button
                onClick={() => setSidebarTab('stops')}
                className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  sidebarTab === 'stops'
                    ? 'border-[#1E3A8A] text-[#1E3A8A]'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Stops ({nonHomeStops.length})
              </button>
              <button
                onClick={() => setSidebarTab('weather')}
                className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 -mb-px flex items-center justify-center gap-1 ${
                  sidebarTab === 'weather'
                    ? 'border-[#1E3A8A] text-[#1E3A8A]'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <CloudRain size={11} /> Weather
                {totalAlerts > 0 && (
                  <span className="bg-amber-500 text-white text-[9px] font-bold px-1 py-0.5 rounded-full leading-none">
                    {totalAlerts}
                  </span>
                )}
              </button>
            </div>

            {/* Tab content — scrollable */}
            <div className="p-3 pb-20 lg:pb-3">
              {sidebarTab === 'stops' && (
                <div className="space-y-0.5">
                  {trip?.stops?.slice().sort((a, b) => a.order - b.order).map(stop => {
                    const isHome   = stop.type === 'HOME'
                    const badge    = stopBadges[stop.id]
                    const hasAlert = stopHasAlerts(weatherData[stop.id])
                    const alerts   = stopAlerts(weatherData[stop.id])

                    const bookingEl = badge === 'S' ? (
                      <span className="text-[9px] text-gray-400">Start</span>
                    ) : badge === 'H' ? (
                      <span className="text-[9px] text-gray-400">Home</span>
                    ) : badge === 'F' && isHome ? (
                      <span className="text-[9px] text-gray-400">Finish</span>
                    ) : stop.bookingStatus === 'CONFIRMED' ? (
                      <span className="flex items-center gap-0.5 text-[9px] text-[#2F4030] font-medium">
                        <CheckCircle size={9} /> Booked
                      </span>
                    ) : stop.bookingStatus === 'PENDING' || stop.bookingStatus === 'WAITLISTED' ? (
                      <span className="flex items-center gap-0.5 text-[9px] text-amber-600 font-medium">
                        <Clock size={9} /> Pending
                      </span>
                    ) : stop.bookingStatus === 'CANCELLED' ? (
                      <span className="flex items-center gap-0.5 text-[9px] text-red-500 font-medium">
                        <XCircle size={9} /> Cancelled
                      </span>
                    ) : (
                      <span className="text-[9px] text-gray-400">Not booked</span>
                    )

                    return (
                      <button
                        key={stop.id}
                        onClick={() => setSelectedStop(stop)}
                        className="w-full text-left flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-50 transition-colors"
                      >
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                          style={{ backgroundColor: isHome ? MC.home : colorForStop(stop) }}
                        >
                          {String(badge)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-900 truncate">{stop.locationName}</p>
                          <p className="text-[10px] text-gray-400">
                            {badge === 'S' ? 'Start' : badge === 'H' ? 'Home · Finish' : badge === 'F' && isHome ? 'Finish' : `${stop.nights}n${stop.type === 'OVERNIGHT_ONLY' ? ' · overnight' : ''}`}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                          {bookingEl}
                          {hasAlert && (
                            <span className="flex items-center gap-0.5 text-[9px] font-medium text-purple-600">
                              🟣 {alerts.length}
                            </span>
                          )}
                          {!stop.isCompatible && <AlertTriangle size={11} className="text-red-400" />}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}

              {sidebarTab === 'weather' && trip && (
                <SidebarWeatherTab trip={trip} weatherData={weatherData} loading={weatherLoading} />
              )}
            </div>
          </div>

        {/* ── Map area ──────────────────────────────────────────────────────────── */}
        <div
          className={isMobile ? 'relative border-b border-gray-200' : 'relative'}
          style={mapExpanded ? {
            position: 'fixed',
            inset: '14px',
            zIndex: 50,
            borderRadius: '8px',
            border: '0.5px solid #d1d5db',
            overflow: 'hidden',
            boxShadow: '0 4px 20px rgba(0,0,0,0.10)',
          } : isMobile ? {
            width: '100%',
            height: '45vh',
            flexShrink: 0,
            order: 1,
          } : !isDesktop ? {
            flex: 1,
            minWidth: 0,
            height: '500px',
            flexShrink: 0,
          } : {
            width: '650px',
            height: '550px',
            flexShrink: 0,
            transition: 'width 0.35s cubic-bezier(0.4, 0, 0.2, 1), height 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {/* Sidebar toggle — shows when sidebar is hidden */}
          {(!sidebarOpen || mapExpanded) && (
            <button
              onClick={() => { setSidebarOpen(true); if (mapExpanded) collapseMap() }}
              className="absolute top-3 left-3 z-10 bg-white rounded-lg p-2 border border-gray-200 hover:bg-gray-50 shadow-sm transition-colors"
              title="Open sidebar"
            >
              <Layers size={16} />
            </button>
          )}

          {/* Expand / collapse map button — tablet and desktop */}
          {!isMobile && (
            <button
              onClick={mapExpanded ? collapseMap : expandMap}
              className="absolute top-3 right-3 z-10 bg-white rounded-lg p-2 border border-gray-200 hover:bg-gray-50 shadow-sm transition-colors"
              title={mapExpanded ? 'Collapse map' : 'Expand map'}
            >
              {mapExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}

          {isLoaded ? (
            <GoogleMap
              mapContainerStyle={MAP_CONTAINER_STYLE}
              zoom={6}
              center={center}
              options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false, mapId: import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID' }}
              onLoad={onMapLoad}
            >
              {/* Driving route */}
              {layers.route && routePath && (
                <Polyline
                  path={routePath}
                  options={{ strokeColor: '#F97316', strokeWeight: 2.5, strokeOpacity: 0.85 }}
                />
              )}

              {/* Weather alert circles */}
              {stopsWithCoords.map(stop =>
                stopHasAlerts(weatherData[stop.id]) ? (
                  <Circle
                    key={`alert-${stop.id}`}
                    center={{ lat: stop.latitude!, lng: stop.longitude! }}
                    radius={9000}
                    options={{ fillColor: '#7F77DD', fillOpacity: 0.18, strokeColor: '#7F77DD', strokeWeight: 1.5, strokeOpacity: 0.55 }}
                  />
                ) : null
              )}

              {/* Info window — rendered inside GoogleMap so it gets map context */}
              {selectedStop?.latitude && selectedStop?.longitude && (
                <InfoWindow
                  position={{ lat: selectedStop.latitude, lng: selectedStop.longitude }}
                  onCloseClick={() => setSelectedStop(null)}
                  options={{ pixelOffset: new window.google.maps.Size(0, -16) }}
                >
                  <StopPopup
                    stop={selectedStop}
                    kind={classifyStop(selectedStop)}
                    weather={weatherData[selectedStop.id]}
                    displayNum={
                      combinedSH && selectedStop.id === stopsWithCoords[0]?.id
                        ? 'S/H'
                        : stopBadges[selectedStop.id]
                    }
                    onClose={() => setSelectedStop(null)}
                    onUpdateNights={handleUpdateNights}
                  />
                </InfoWindow>
              )}
            </GoogleMap>
          ) : (
            <div className="h-full flex items-center justify-center bg-gray-100 text-sm text-gray-500">
              Loading map…
            </div>
          )}

          {/* Legend */}
          {isLoaded && trip && <MapLegend />}

          {/* Geocoding indicator */}
          {geocoding && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white border border-gray-200 rounded-full px-4 py-2 text-xs text-gray-600 shadow-md flex items-center gap-2 z-10">
              <span className="w-3 h-3 rounded-full border-2 border-[#1E3A8A] border-t-transparent animate-spin" />
              Finding stop locations…
            </div>
          )}
        </div>
      </div>{/* end map row */}
      </div>{/* end flex-1 wrapper */}

      {/* Modify Trip AI panel */}
      {trip && (
        <Suspense fallback={null}>
          <ModifyTripPanel
            trip={trip}
            isOpen={modifyPanelOpen}
            onClose={() => setModifyPanelOpen(false)}
            onTripUpdated={updatedTrip => {
              setTrip(updatedTrip)
              setTripNameInput(updatedTrip.name)
            }}
          />
        </Suspense>
      )}

      {/* Mark-completed confirmation */}
      <ConfirmModal
        isOpen={confirmCompleteOpen}
        title="Mark trip as completed?"
        message="This will move your trip to the Completed section. You'll still be able to view the itinerary and journal entries, but the trip won't appear in your active planning list."
        confirmLabel="Mark completed"
        cancelLabel="Not yet"
        onConfirm={handleMarkCompleted}
        onCancel={() => !changingStatus && setConfirmCompleteOpen(false)}
        isConfirming={changingStatus}
      />
    </div>
  )
}
