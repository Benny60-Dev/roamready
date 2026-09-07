import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { GoogleMap, useJsApiLoader, OverlayViewF, Circle, Polyline } from '@react-google-maps/api'
import {
  Layers, X, Plus, Minus, DollarSign, Calendar, AlertTriangle,
  Wind, Droplets, Snowflake, Thermometer, ExternalLink,
  Pencil, Trash2, Check, BookOpen, Package, Share2, Download, CheckCircle, CloudRain, Wand2,
  Maximize2, Minimize2, Tent, Bed, CalendarPlus, Flag, Info,
} from 'lucide-react'
import { DayPicker } from 'react-day-picker'
import 'react-day-picker/style.css'
import { formatTripDate, lifecycleDate, parseTripDate, toYmd } from '../../utils/dates'
import { type DirectionsWaypoint } from '../../utils/directions'
import { NavigateButton, WholeTripButton } from '../../components/trip/NavigateSheet'
import { tripsApi, usersApi } from '../../services/api'
import { Trip, Stop, Rig, StopWeather, LiveForecast, TripFuelEstimate } from '../../types'
import { computeTripTotals } from '../../utils/tripTotals'
import { StopWeatherCard, ALERT_STYLES } from '../../components/weather/StopWeatherCard'
const ModifyTripPanel = lazy(() => import('../../components/trip/ModifyTripPanel'))
import TripRigSelector from '../../components/trip/TripRigSelector'
import RigWarningPill from '../../components/trip/RigWarningPill'
import ConfirmModal from '../../components/ui/ConfirmModal'
import ShareModal from '../../components/trip/ShareModal'
import { useAuthStore } from '../../store/authStore'
import { useUIStore } from '../../store/uiStore'
import { sharePdfBlob } from '../../utils/sharePdf'
import { buildStopBadges, formatStopBadgeLabel, formatStopBadgeMarker, isHomeBadge } from '../../utils/stopBadge'
import { deriveTripStatus } from '../../utils/tripStatus'
import { userFacingStopCount } from '../../utils/userFacingStopCount'

const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' }
const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

// FEAT-HERE-ROUTING (display) — client mirror of the server USE_HERE_ROUTING flag.
// Only when this is on do we fetch HERE corridor waypoints and route the map line +
// directions links through them. Off (default) → Google-only display, no extra
// fetch, byte-identical to before. Benny sets BOTH server + client flags together.
// Rig-aware map-line display: on when EITHER truck-routing engine's display
// flag is set. The wire fields (herePolyline/hereDistanceMeters/hereWaypoints)
// are engine-agnostic — the server fills them from LVR or HERE (FEAT-LVR-ROUTING).
const USE_HERE_ROUTING_DISPLAY =
  import.meta.env.VITE_USE_HERE_ROUTING === 'true' ||
  import.meta.env.VITE_USE_LVR_ROUTING === 'true'

// FEAT-RIG-AWARE-INDICATOR — client-side copy of the server's RV_FALLBACK_NOTE
// wording ("Heads up" prefix = amber advisory tier in RigWarningPill). Attached
// to a stop whose ARRIVING leg fell back to car routing while a rig-aware
// engine was enabled (rigAware === false from POST /trips/:id/routes).
const RV_FALLBACK_DISPLAY_NOTE =
  'This drive is not planned for your rig — rig-aware routing isn’t available here, so its drive time and route come from standard car routing. Check clearances, grades and restrictions for your rig on this leg yourself.'

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

/** Creates the HTML element used as the AdvancedMarkerElement content.
 *  When `offset` is non-zero the rendered icon is translated in pixel space —
 *  used by the co-located-stops deconflict pass to fan stacked markers out.
 *  The marker's underlying lat/lng anchor stays at the stop's true coords so
 *  the popup (which anchors to selectedStop's lat/lng) lands at the right
 *  geographic point regardless of how the icon is offset. */
function makeMarkerContent(
  kind: MarkerKind,
  badge: string | number | undefined,
  offset: { x: number, y: number } = { x: 0, y: 0 },
): HTMLElement {
  const div = document.createElement('div')
  const text = badge != null ? String(badge) : ''
  const fontSize = text.length > 2 ? '8px' : '11px'
  div.style.cssText = `width:26px;height:26px;border-radius:50%;background:${KIND_COLOR[kind]};border:3px solid white;display:flex;align-items:center;justify-content:center;color:white;font-size:${fontSize};font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:pointer;letter-spacing:-0.5px`
  if (offset.x !== 0 || offset.y !== 0) {
    div.style.transform = `translate(${offset.x}px, ${offset.y}px)`
  }
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
function MapLegend({ combinedSH }: { combinedSH: boolean }) {
  // When the trip is a 2-stop home→home loop, both endpoints share a single
  // marker labeled 'S/H' — surface that as one combined legend row instead of
  // two redundant Start/Finish entries that would point at the same point.
  //
  // Non-combined: ONE finish row. A trip's last stop is badged either 'H'
  // (loop, ends home) or 'F' (one-way) — never both — and the map draws every
  // finish endpoint orange with the character 'F' (H is transformed H→F, all
  // endpoints forced MC.home). So the legend mirrors that exactly: a single
  // 'F'/orange/"Finish" row. Listing H and F separately printed a literal 'H'
  // the map never draws and a gray 'F' that didn't match the orange marker.
  const endpointEntries = combinedSH
    ? [{ letter: 'S/H', color: MC.home, label: 'Start · Finish' }]
    : [
        { letter: 'S', color: MC.home, label: 'Start' },
        { letter: 'F', color: MC.home, label: 'Finish' },
      ]
  return (
    <div className="absolute bottom-6 left-4 bg-white rounded-xl border border-gray-200 px-3 py-2.5 shadow-md z-10" style={{ borderWidth: '0.5px' }}>
      <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Legend</p>
      <div className="space-y-1.5">
        {endpointEntries.map(({ letter, color, label }) => (
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
  stop, kind, weather, displayNum, onClose, onUpdateNights, tripId, prevStop, waypoints, rigAware,
}: {
  stop: Stop
  kind: MarkerKind
  weather: StopWeather | null | undefined
  displayNum?: 'S' | 'H' | 'F' | 'S/H' | number
  onClose: () => void
  onUpdateNights: (id: string, nights: number) => void
  // Trip id so a CONFIRMED ("Booked") stop's badge can deep-link to its
  // reservation panel, matching the stops-list pill. Optional: absent → plain badge.
  tripId?: string
  // The previous stop by order, so the popup can offer driving directions TO
  // this stop. Absent on the first stop (no prior leg) → no directions link.
  prevStop?: Stop
  // FEAT-HERE-ROUTING — HERE corridor waypoints for the prevStop→stop leg, applied
  // to the "from previous stop" link so it follows HERE's RV-safe path. Only valid
  // for that origin (not "from my location", whose origin is the device).
  waypoints?: DirectionsWaypoint[]
  // FEAT-NAV-HANDOFF — provenance of the arriving leg (see rigAwareByStop).
  rigAware?: boolean
}) {
  const badge  = BOOKING_BADGE[kind]
  const alerts = stopAlerts(weather)
  const nwsUrl = stop.latitude && stop.longitude
    ? `https://forecast.weather.gov/MapClick.php?lat=${stop.latitude}&lon=${stop.longitude}`
    : null
  // Prefer the user-entered actualRate (recorded during a booking commit)
  // over the AI estimate (siteRate). Matches the booking page's
  // actualRate ?? siteRate pattern shipped in bdb4192 — the map popup was
  // the last surface still reading from the estimate-only field.
  const displayRate = stop.actualRate ?? stop.siteRate
  // All-in total = rate × nights + fees. Fees only count when actualRate is
  // present (an unbooked stop with just an estimate has no fees to add).
  // Same formula as the booking-page header's totalCampCost reduce.
  // Recomputes on every render so the nights stepper's setSelectedStop
  // patch flows through live — bump nights from 1 to 2 and the total
  // jumps without a refetch.
  const displayTotal = displayRate != null
    ? displayRate * stop.nights + (stop.actualRate != null ? (stop.actualFees ?? 0) : 0)
    : null

  let weatherSummary: React.ReactNode = null
  if (weather?.mode === 'live') {
    const today = (weather as LiveForecast).days[0]
    if (today) weatherSummary = (
      <div className="flex items-center gap-2 text-xs text-gray-600 mb-2 bg-gray-100 rounded px-2 py-1.5 border border-gray-200">
        <span className="text-base leading-none">{today.icon}</span>
        <span>{today.high}° / {today.low}° · {today.conditions}</span>
        {nwsUrl && (
          <a href={nwsUrl} target="_blank" rel="noreferrer" className="ml-auto text-[#1F6F8B] hover:underline flex-shrink-0">
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
    <div className="flex flex-col items-center">
    <div className="bg-white rounded-xl shadow-xl p-4 w-72">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
            {displayNum === 'S/H' ? 'Start · Finish' : displayNum !== undefined ? formatStopBadgeLabel(displayNum) : ''}
          </span>
          {kind === 'booked' && tripId ? (
            // CONFIRMED → deep-link the "Confirmed" badge to this stop's reservation
            // panel, parity with the stops-list "Booked" pill. stopPropagation keeps
            // the popup's own handlers from firing; booking page handles ?stopId=.
            <Link
              to={`/trips/${tripId}/booking?stopId=${stop.id}`}
              onClick={e => e.stopPropagation()}
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded hover:underline transition-colors ${badge.cls}`}
            >
              {badge.label}
            </Link>
          ) : (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
          )}
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
        {displayRate != null && displayTotal != null && (
          <span className="ml-auto text-xs text-gray-500 flex items-center gap-0.5">
            <DollarSign size={11} />${displayRate}/night · ${displayTotal} total
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mt-1.5 text-xs text-gray-400">
        {stop.arrivalDate && (
          <span className="flex items-center gap-0.5"><Calendar size={10} />{formatTripDate(stop.arrivalDate, 'M/d/yyyy')}</span>
        )}
        {stop.hookupType && <span className="badge-green text-[10px]">{stop.hookupType}</span>}
        {stop.isPetFriendly && <span className="text-[#0F766E]">🐾 Pet-friendly</span>}
      </div>

      {/* FEAT-NAV-HANDOFF — Navigate TO this stop (omitted on the first stop:
          you don't navigate to where you begin). Opens the Navigate sheet
          (origin choice, Google/Apple, measured-for-your-rig status). */}
      {prevStop && (
        <div className="mt-2 pt-2 border-t border-gray-100" onClick={e => e.stopPropagation()}>
          <NavigateButton
            stop={stop} prevStop={prevStop} waypoints={waypoints} rigAware={rigAware}
            tripId={tripId} source="map-popup" compact
          />
        </div>
      )}

      {/* Badge-based gate: only real bookable destinations get the button.
          'S' / 'H' / 'F' / 'S/H' are endpoints (no campground card on the
          booking page), so a return-home destination typed DESTINATION but
          badged 'H' correctly skips the button now. */}
      {stop.bookingStatus !== 'CONFIRMED' && typeof displayNum === 'number' && (
        <a href={`/trips/${stop.tripId}/booking`} className="btn-primary w-full mt-3 text-center text-xs block">
          Book this stop!
        </a>
      )}
    </div>
    {/* Triangle pointer — sibling of the card, pointing down at the marker.
        margin-top: -1px overlaps the card's bottom edge by 1px to hide the
        seam between card and triangle. The drop-shadow continues the
        card's shadow naturally onto the triangle. */}
    <svg
      width="20"
      height="8"
      viewBox="0 0 20 8"
      className="block"
      style={{ marginTop: '-1px', filter: 'drop-shadow(0 4px 4px rgba(0,0,0,0.06))' }}
    >
      <path d="M0 0 L10 8 L20 0 Z" fill="white" />
    </svg>
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
          <div className="w-3 h-3 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin" />
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
              <div className="w-4 h-4 rounded-full bg-[#1F6F8B] flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
                {idx + 1}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-900 truncate">
                  {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
                </p>
              </div>
              {stop.arrivalDate && (
                <span className="text-[10px] text-gray-400 flex-shrink-0">
                  {formatTripDate(stop.arrivalDate, 'MMM d')}
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
  // RIG-CHANGE Phase 2 — the user's profile rigs, for the "Rig for this trip"
  // selector and to resolve the current rig's length for the booked-fit banner
  // and per-stop "booked for" labels.
  const [rigs, setRigs]                     = useState<Rig[]>([])
  // Layers state retired with the Layers panel — all four layers stay on
  // permanently. None of them had a plausible "turn off" use case, and
  // the panel itself was adding sidebar noise without earning its space.
  // If a future need surfaces, the toggles can move behind a gear menu
  // on the map itself rather than living in the sidebar.
  const [weatherData, setWeatherData]       = useState<Record<string, StopWeather | null | undefined>>({})
  const [weatherLoading, setWeatherLoading] = useState(false)
  const [geocoding, setGeocoding]           = useState(false)
  const [routePath, setRoutePath]           = useState<google.maps.LatLng[] | null>(null)
  // FEAT-HAZARD-MAP-PILL — RV hazard warnings for this built trip, recomputed on
  // load via GET /trips/:id/hazards (violationNotes are NOT persisted on the Stop
  // row). Keyed by stopId → the red "Rig warning" pill renders on matching stops.
  const [hazardsByStop, setHazardsByStop]   = useState<Map<string, string[]>>(new Map())
  // FEAT-HERE-ROUTING (display) — per-leg HERE data, keyed by DESTINATION stop id
  // (robust against coord-filtering). Populated only when VITE_USE_HERE_ROUTING is
  // on; empty otherwise → Google-only display, byte-identical to before.
  //   • hereLine     : HERE's FULL decoded polyline → drawn DIRECTLY as the map
  //                    line (no Google via-reconstruction, so no hooks).
  //   • hereDist     : HERE's measured leg distance (meters) → shown mileage.
  //   • hereWaypoints: ≤3 snapped corridor points → directions-link URLs ONLY.
  const [hereLine, setHereLine]             = useState<Map<string, Array<[number, number]>>>(new Map())
  const [hereDist, setHereDist]             = useState<Map<string, number>>(new Map())
  const [hereWaypoints, setHereWaypoints]   = useState<Map<string, DirectionsWaypoint[]>>(new Map())
  // FEAT-RIG-AWARE-INDICATOR — per-leg provenance keyed by destination stop id.
  const [rigAwareByStop, setRigAwareByStop] = useState<Map<string, boolean>>(new Map())
  const hereRoutesKey = useRef<string | null>(null)
  // Imperative handle to the underlying google.maps.Polyline. Captured via
  // <Polyline onLoad>; used by the useEffect below to push setRoutePath
  // changes directly to the on-map polyline. Bypasses the declarative
  // path-prop handling in @react-google-maps/api v2.19.3, which empirically
  // wasn't propagating subsequent setRoutePath calls even with a key-driven
  // remount. See the scout notes in the polyline fix commit.
  const polylineRef = useRef<google.maps.Polyline | null>(null)
  // FIX-GHOST-ROUTE-LINE — read at Google-fetch RESOLVE time (the closure's
  // useHereLine is captured at fetch START and can be stale): when the rig-aware
  // polyline owns the line, a late-resolving Google car line must not overwrite it.
  const hereOwnsLineRef = useRef(false)
  const [mapInstance, setMapInstance]       = useState<google.maps.Map | null>(null)
  // FEAT-MAP-TYPE-TOGGLE: 'hybrid' = satellite imagery WITH road/place labels
  const [mapTypeId, setMapTypeId]           = useState<'roadmap' | 'hybrid' | 'terrain'>('roadmap')
  // FEAT-TRAFFIC-TOGGLE: live traffic overlay, OFF by default (a driving-day
  // tool; always-on coloring clutters the planning view). The TrafficLayer
  // instance is created once and re-attached/detached via the effect below.
  const [trafficOn, setTrafficOn]           = useState(false)
  const trafficLayerRef                     = useRef<google.maps.TrafficLayer | null>(null)
  // Rename pencil — restored to name-only after the 3f8ed99 popover rework
  // bundled name+date editing behind one affordance and lost discoverability
  // on the date side. Dates now live on their own clickable line below the
  // trip name (see dateEditorOpen below).
  const [renaming, setRenaming]             = useState(false)
  const [tripNameInput, setTripNameInput]   = useState('')
  // First-class date line — clickable row directly under the trip name,
  // shows "May 27 – Jun 10" when set or a "Set start date" prompt when not.
  // Click toggles dateEditorOpen and the row transforms into an inline
  // editor (no popover, no position:fixed — the editor flows inline and
  // pushes the rest of the header down, so the sidebar's overflow:hidden
  // at L1252 can't clip it).
  //
  // Auto-save: <input type="date">'s onChange schedules a debounced save
  // (saveTimerRef) so picker-navigation streams (notably iOS wheel pickers,
  // which fire onChange on every wheel tick) collapse into ONE shiftDates
  // call. Chrome/Edge/Firefox fire one onChange per commit anyway — they
  // hit the same debounce and fire ~400ms after the pick. End date is
  // displayed read-only inside the editor because it's a derived quantity
  // (server-side recomputeStopDates: endDate = anchor + Σ stop nights);
  // length changes happen via remove-stop / change-nights, surfaced by the
  // editor's caption.
  const [dateEditorOpen, setDateEditorOpen] = useState(false)
  const [startDateInput, setStartDateInput] = useState('')
  const [savingDate, setSavingDate]         = useState(false)
  const dateLineWrapperRef                  = useRef<HTMLDivElement>(null)
  const saveTimerRef                        = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [modifyPanelOpen, setModifyPanelOpen] = useState(false)
  const [mapExpanded, setMapExpanded]       = useState(false)
  // Live regional fuel-cost estimate. Same fetch shape as TripSummaryPage —
  // async, non-blocking. Null while loading; populated by the useEffect
  // below once the trip is ready. Passed through to computeTripTotals so
  // the map's "Est. cost" stat matches what the itinerary shows.
  const [fuelEstimate, setFuelEstimate]     = useState<TripFuelEstimate | null>(null)
  const [isMobile, setIsMobile]             = useState(() => window.innerWidth < 768)
  const [isDesktop, setIsDesktop]           = useState(() => window.innerWidth >= 1024)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  // Per-stop edit/delete affordances on the sidebar — parity with the
  // Itinerary page's day cards (commit df75a17). Modals + handlers follow
  // the same pattern; server guards (commit 1ab72ad) catch HOME / min-stops
  // violations on the AI modify path even when the UI hides the option.
  // editingStop / savingStop state retired with the Edit Stop modal.
  const [pendingDeleteStop, setPendingDeleteStop] = useState<Stop | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Long-drive opt-in (Part 2): trashing an OVERNIGHT_ONLY whose removal re-merges
  // an over-cap leg first measures it (preview), then asks "keep the long drive?"
  // with the REAL hours before deleting + acknowledging. checkingLongLeg covers the
  // preview round-trip so a double trash-click doesn't double-fire.
  const [longDrivePrompt, setLongDrivePrompt] = useState<
    { stop: Stop; legHours: number; cap: number; fromName: string; toName: string } | null
  >(null)
  const [checkingLongLeg, setCheckingLongLeg] = useState(false)

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

  // Open a stop's popup AND move the camera so the popup is actually visible.
  // The popup is an <OverlayViewF> geographically anchored to the stop's
  // lat/lng (see ~L2151), so when the clicked stop sits outside the current
  // viewport the popup renders off-screen and the click looks like a no-op —
  // especially on sidebar-list clicks for stops far from the current center.
  // Pan to the stop, then nudge the camera down so the marker lands in the
  // lower third of the viewport, leaving room above for the ~260px popup
  // card. Offset scales with map height so the mobile 45vh layout doesn't
  // get an oversized pan that shoots past the viewport bottom.
  //
  // FEAT-TRAFFIC-TOGGLE: attach/detach the traffic overlay. Works in all three
  // map types; cleanup detaches on unmount so an expanded->collapsed remount
  // never leaks a layer bound to a dead map instance.
  useEffect(() => {
    if (!mapInstance) return
    if (trafficOn) {
      if (!trafficLayerRef.current) trafficLayerRef.current = new google.maps.TrafficLayer()
      trafficLayerRef.current.setMap(mapInstance)
    } else {
      trafficLayerRef.current?.setMap(null)
    }
    return () => { trafficLayerRef.current?.setMap(null) }
  }, [mapInstance, trafficOn])

  // Guarded with mapInstance && lat/lng so first-load races safely no-op
  // (selectedStop still updates — never worse than today's behavior).
  // panTo short-circuits when the target is already in view, so clicks on
  // an already-centered stop don't trigger a redundant camera animation;
  // panBy still applies a small downward nudge in that case, which keeps
  // the popup unclipped at the top and is acceptable UX.
  const focusStop = useCallback((stop: Stop) => {
    setSelectedStop(stop)
    if (mapInstance && stop.latitude != null && stop.longitude != null) {
      mapInstance.panTo({ lat: stop.latitude, lng: stop.longitude })
      // Popup wrapper height conservatively estimated for the full content variant
      // (card with weather summary + 2 alerts + Book button: ~296px wrapper, plus
      // 36px gap from marker to triangle, plus 24px breathing room above the popup).
      const NEEDED_CLEARANCE_PX = 296 + 36 + 24  // = 356
      const mapH = mapInstance.getDiv()?.clientHeight ?? 550
      // Move marker DOWN into lower portion of viewport so NEEDED_CLEARANCE_PX
      // fits above it. Marker's final screen-y after panBy = mapH/2 + offset,
      // so offset >= NEEDED_CLEARANCE_PX - mapH/2 places the popup top at the
      // viewport's top edge (with 24px breathing built in).
      const idealOffset = Math.max(NEEDED_CLEARANCE_PX - mapH / 2, 80)
      // Safety cap: never push the marker past 80% down from top — keeps marker
      // visible on small mobile maps (45vh ~340px) even if popup is taller than
      // viewport. User can scroll/drag for the rest in that edge case.
      const capOffset = mapH * 0.3
      const offset = Math.min(idealOffset, capOffset)
      // CRITICAL: panBy(0, NEGATIVE) moves map CENTER UP, which makes the
      // marker appear LOWER on screen — which is what we want. Google's
      // coordinate system: +y is south (down) in the map frame, so
      // panBy(0, +y) pulls the camera south and pushes markers north on
      // screen. The previous +offset was inverted and made the bug WORSE
      // for stops in the upper map area (the Crested Butte case — popup
      // ran off the top edge because the marker was being shoved into
      // the upper-third instead of the lower-third).
      mapInstance.panBy(0, -offset)
    }
  }, [mapInstance])

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

  // Date-line editor — outside-click + Escape close. Editor also auto-closes
  // on a successful save inside commitStartDate; this handler is for the
  // no-save dismiss paths (clicked elsewhere, hit Escape, picked the same
  // date the trip already had so commit no-op'd).
  //
  // SHADOW-DOM SUBTLETY — Node.contains() does NOT cross shadow boundaries.
  // Native <input type="date"> renders its picker UI inside the input's
  // shadow root (Chrome) or as a browser-level overlay outside the document
  // tree. A click on a date cell in the picker has e.target inside that
  // shadow DOM, so wrapper.contains(target) returns false — and an earlier
  // version of this handler treated picker clicks as outside-clicks, closed
  // the editor immediately, and (combined with a now-removed cancel-on-
  // close effect on the save timer) lost the user's most recent pick before
  // the debounced shiftDates request could fire. The DB-confirmed repro:
  // a COMPLETED→future edit that left the trip stuck at its original dates.
  //
  // Fix: use e.composedPath() instead. composedPath traverses through shadow
  // boundaries and lists every node the event passed through on its way to
  // the document. If the wrapper appears anywhere in that path, the click
  // originated inside the editor (including inside the picker), and the
  // editor stays open. composedPath is standard in every browser the app
  // targets; the optional-chain on dateLineWrapperRef handles the ref
  // being null on mount/unmount transitions.
  useEffect(() => {
    if (!dateEditorOpen) return
    function onPointer(e: PointerEvent) {
      const wrapper = dateLineWrapperRef.current
      if (!wrapper) return
      const path = e.composedPath()
      if (path.includes(wrapper)) return
      setDateEditorOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDateEditorOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [dateEditorOpen])

  // Unmount cleanup — clear any pending debounced shiftDates so a phantom
  // request can't fire after the component unmounts (e.g. user navigates
  // away mid-debounce). Deliberately does NOT cancel on editor close: a
  // pending save when the editor closes is the user's most recent picked
  // date, and the correct semantic is to commit it. Native date inputs
  // only emit onChange for complete valid dates, and commitStartDate's
  // no-op guard short-circuits same-value picks, so letting the pending
  // save fire is safe — it's exactly the user's expressed intent.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [])

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
        // Deliberately RAW length (not user-facing count): analytics/telemetry
        // semantics stay stable for comparability with historical data.
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
      // Remember this trip as the best-guess for feedback opened elsewhere.
      useUIStore.getState().rememberTrip(data.id, data.name)
    })
  }, [id])

  // RIG-CHANGE Phase 2 — load the user's profile rigs once, for the rig selector
  // and the current-rig-length resolution behind the booked-fit banner/labels.
  useEffect(() => {
    usersApi.getRigs()
      .then(res => setRigs(Array.isArray(res.data) ? res.data : []))
      .catch(err => console.error('[TripMapPage] rig load failed', err))
  }, [])

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
      .catch(err => {
        // Fetch-level failure (network, 5xx, 403 FEATURE_GATED, etc.) —
        // leave slots as `undefined` so SidebarWeatherTab's
        // "Weather unavailable" hint can fire after loading flips false.
        // The previous behavior promoted every undefined slot to `null`,
        // which made fetch failures visually identical to "this stop has
        // no forecast available" (a per-stop server response) — the
        // server bug that returned { stopId: null } for every stop on
        // live-mode trips therefore rendered as a silently-blank tab.
        // Keep `null` reserved for the legitimate per-stop response.
        console.error(
          '[TripMapPage] weather fetch failed:',
          err?.response?.status, err?.response?.data?.code, err?.message,
        )
      })
      .finally(() => setWeatherLoading(false))
  }, [trip?.stops])

  // ── Fetch the regional fuel-cost estimate ─────────────────────────────────────
  // Same pattern as TripSummaryPage so the map's "Est. cost" stat matches the
  // itinerary's. Async + non-blocking — the stat shows "–" until the estimate
  // lands. Errors silently log; a failed fetch leaves fuelEstimate null which
  // computeTripTotals treats as "camp only" (cleaner than rendering NaN).
  useEffect(() => {
    if (!id || !trip?.id) return
    tripsApi.getFuelEstimate(id)
      .then(res => setFuelEstimate(res.data))
      .catch(err => {
        console.warn('[TripMapPage] fuel estimate fetch failed:', err?.message ?? err)
        setFuelEstimate(null)
      })
  }, [id, trip?.id])

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
    //   • A HOME-typed stop whose city matches user.homeCity (true home departure)
    //   • The last stop when its city matches user.homeCity (returning home)
    // A HOME-typed stop whose city does NOT match (e.g. a trip starting from San Jose)
    // is excluded from this set so it falls through to the geocoder below, which
    // resolves the real start-city coordinates instead of applying Mesa's address.
    const exactHomeStops = hasExactHome
      ? allMissing.filter(s => {
          const cityIsHome = !!user?.homeCity &&
            s.locationName.toLowerCase().trim() === user.homeCity.toLowerCase().trim()
          return (s.type === 'HOME' || s.id === lastStop?.id) && cityIsHome
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
    // Canadian provinces/territories. Stops in these resolve to Canada with a
    // CA component restriction so ambiguous names (e.g. "Vancouver, BC") don't
    // collide with a US namesake (Vancouver, WA) under a forced "USA" suffix.
    // The Alaska route runs through BC + YT, so this is a real route, not an
    // edge case. locationState is a 2-letter code in this data (e.g. "BC").
    const CA_PROVINCES = new Set(['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'])
    // US states + DC. Clean 2-letter codes, the dominant case. A stop whose state
    // is one of these — OR whose state is blank (overwhelmingly a US stop; keeping
    // the US default avoids "Paris" → Paris, France for a state-less row) — is
    // FORCED to the US, identical to the prior behavior (zero regression).
    const US_STATES = new Set([
      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
      'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
      'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
      'WI','WY','DC',
    ])
    // Full US state names — this data stores some states as full names ("Arizona",
    // "Montana", "Utah", "Wyoming") rather than the 2-letter code, so the code set
    // alone would route them to the unrestricted branch. Critically this also
    // closes the "Georgia" hole: the full name "Georgia" is a US-state-vs-COUNTRY
    // collision, so a stop stored as "Georgia" must force US, not go unrestricted.
    // Compared upper-cased (matches the stateUC normalization below).
    const US_STATE_NAMES = new Set([
      'ALABAMA','ALASKA','ARIZONA','ARKANSAS','CALIFORNIA','COLORADO','CONNECTICUT',
      'DELAWARE','FLORIDA','GEORGIA','HAWAII','IDAHO','ILLINOIS','INDIANA','IOWA',
      'KANSAS','KENTUCKY','LOUISIANA','MAINE','MARYLAND','MASSACHUSETTS','MICHIGAN',
      'MINNESOTA','MISSISSIPPI','MISSOURI','MONTANA','NEBRASKA','NEVADA',
      'NEW HAMPSHIRE','NEW JERSEY','NEW MEXICO','NEW YORK','NORTH CAROLINA',
      'NORTH DAKOTA','OHIO','OKLAHOMA','OREGON','PENNSYLVANIA','RHODE ISLAND',
      'SOUTH CAROLINA','SOUTH DAKOTA','TENNESSEE','TEXAS','UTAH','VERMONT','VIRGINIA',
      'WASHINGTON','WEST VIRGINIA','WISCONSIN','WYOMING','DISTRICT OF COLUMBIA',
    ])

    Promise.all(toGeocode.map(stop =>
      new Promise<{ stop: Stop; lat: number; lng: number } | null>(resolve => {
        // BUG-TRIP-MAPPINS (general) — the prior logic forced "USA" + a US
        // component restriction onto EVERY non-Canadian stop, so foreign cities
        // (Vancouver pre-RR47, now Mexico, and any future country) resolved to a
        // wrong US fallback. Only FORCE a country for the known-clean code sets;
        // for any other PRESENT state, geocode the raw "City, State" with NO
        // appended country and NO restriction, letting Google resolve the country
        // itself. No per-country enumeration — Mexico et al. just work.
        const stateUC = stop.locationState?.trim().toUpperCase() || ''
        const isCanadian = CA_PROVINCES.has(stateUC)
        // US when the state is a 2-letter code, a full state name, OR blank (the
        // blank-state US default). Full-name match is what forces "Arizona" and,
        // critically, "Georgia" to the US rather than letting them go unrestricted.
        const isUS = US_STATES.has(stateUC) || US_STATE_NAMES.has(stateUC) || stateUC === ''
        // restrictCountry null = unrestricted (genuinely-foreign, non-US/CA stop).
        const restrictCountry = isCanadian ? 'CA' : isUS ? 'US' : null
        const countryWord = isCanadian ? 'Canada' : isUS ? 'USA' : null
        const q = [stop.locationName, stop.locationState, countryWord].filter(Boolean).join(', ')
        const geocodeReq: google.maps.GeocoderRequest = { address: q }
        if (restrictCountry) geocodeReq.componentRestrictions = { country: restrictCountry }
        geocoder.geocode(geocodeReq, (results, status) => {
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
    .catch(err => {
      // Never leave `geocoding` stuck true: the route-draw effect early-returns
      // while geocoding, so a stuck flag would freeze the route polyline until a
      // page reload. Reset it on any failure in the chain (e.g. an updateStop write
      // rejecting after a modify-added stop).
      console.warn('[TripMapPage] geocode chain failed — resetting geocoding flag:', err?.message ?? err)
      setGeocoding(false)
    })
  }, [isLoaded, trip?.stops, user?.homeLat, user?.homeLng, user?.homeCity])

  // ── Pin HOME stops to exact home coordinates ───────────────────────────────────
  // Runs independently of the geocode effect so it also corrects stops that were
  // previously geocoded to city center (non-null coords that are still wrong).
  // City match required for both HOME-typed and return-home stops: a HOME-typed stop
  // whose city does NOT match homeCity (e.g. a non-home trip origin like San Jose)
  // must NOT be pinned to Mesa — only stops actually at the user's home city are.
  useEffect(() => {
    if (!id || !trip?.stops?.length || !user?.homeLat || !user?.homeLng) return

    const sortedAll = trip.stops.slice().sort((a, b) => a.order - b.order)
    const lastStop  = sortedAll[sortedAll.length - 1]

    const stopsToPin = trip.stops.filter(s => {
      const cityIsHome = !!user?.homeCity &&
        s.locationName.toLowerCase().trim() === user.homeCity.toLowerCase().trim()
      const isHomeType   = s.type === 'HOME' && cityIsHome
      const isReturnHome = s.id === lastStop?.id && cityIsHome
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
  }, [trip?.stops, user?.homeLat, user?.homeLng, user?.homeCity])

  // Push routePath changes imperatively to the underlying polyline. Bypasses
  // the @react-google-maps/api v2.19.3 declarative path-prop handling, which
  // empirically wasn't propagating setRoutePath updates to the on-map
  // polyline even with a content-derived key forcing remount. Verified via
  // the Cheyenne add-stop test — see commit b5d4282.
  useEffect(() => {
    if (routePath && polylineRef.current) {
      polylineRef.current.setPath(routePath)
    }
  }, [routePath])

  // ── FEAT-HERE-ROUTING (display): fetch HERE corridor waypoints per leg ────────
  // One call per stop set (coords-keyed), gated on the client flag. Fail-soft —
  // any error leaves hereWaypoints empty so the map line + links fall back to
  // Google-only display. Keyed by destination stop id (see server generateRoutes).
  useEffect(() => {
    if (!USE_HERE_ROUTING_DISPLAY || !id || !trip?.stops?.length) return
    const coordStops = trip.stops
      .filter(s => s.latitude && s.longitude)
      .sort((a, b) => a.order - b.order)
    if (coordStops.length < 2) return
    const key = coordStops.map(s => `${s.id}:${s.latitude},${s.longitude}`).join('|')
    if (hereRoutesKey.current === key) return
    hereRoutesKey.current = key

    tripsApi.generateRoutes(id)
      .then(res => {
        const rows: any[] = Array.isArray(res.data) ? res.data : []
        const lineMap = new Map<string, Array<[number, number]>>()
        const distMap = new Map<string, number>()
        const wpMap = new Map<string, DirectionsWaypoint[]>()
        const rigAwareMap = new Map<string, boolean>()
        for (const r of rows) {
          if (!r?.toStopId) continue
          // FULL HERE polyline → the map line.
          if (Array.isArray(r.herePolyline) && r.herePolyline.length >= 2) {
            const pts = r.herePolyline.filter(
              (p: any) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number',
            ) as Array<[number, number]>
            if (pts.length >= 2) lineMap.set(r.toStopId, pts)
          }
          // HERE measured distance → mileage.
          if (typeof r.hereDistanceMeters === 'number' && r.hereDistanceMeters > 0) {
            distMap.set(r.toStopId, r.hereDistanceMeters)
          }
          // ≤3 snapped waypoints → directions-link URLs only.
          if (Array.isArray(r.hereWaypoints) && r.hereWaypoints.length > 0) {
            wpMap.set(r.toStopId, r.hereWaypoints
              .filter((w: any) => typeof w?.lat === 'number' && typeof w?.lng === 'number')
              .map((w: any) => ({ lat: w.lat, lng: w.lng })))
          }
          // FEAT-RIG-AWARE-INDICATOR — per-leg provenance from the same response.
          if (typeof r.rigAware === 'boolean') rigAwareMap.set(r.toStopId, r.rigAware)
        }
        setHereLine(lineMap)
        setHereDist(distMap)
        setHereWaypoints(wpMap)
        setRigAwareByStop(rigAwareMap)
        console.log('[TripMapPage] HERE display data: line for', lineMap.size, 'leg(s),',
          wpMap.size, 'leg(s) with link waypoints')
      })
      .catch(err => {
        console.warn('[TripMapPage] HERE display fetch failed (Google-only display):', err?.message)
        setHereLine(new Map()); setHereDist(new Map()); setHereWaypoints(new Map()); setRigAwareByStop(new Map())
      })
  }, [id, trip?.stops])

  // FEAT-HAZARD-MAP-PILL — fetch recomputed hazard warnings for this trip and key
  // them by stopId. Re-runs when the stop set or the assigned rig changes (gating
  // is rig-dependent). Fail-soft: any error → no pills, map otherwise unchanged.
  useEffect(() => {
    if (!id || !trip?.stops?.length) { setHazardsByStop(new Map()); return }
    tripsApi.getHazards(id)
      .then(res => {
        const m = new Map<string, string[]>()
        for (const h of res.data?.hazards ?? []) {
          if (h?.stopId && Array.isArray(h.violationNotes) && h.violationNotes.length > 0) {
            m.set(h.stopId, h.violationNotes.filter(n => typeof n === 'string'))
          }
        }
        setHazardsByStop(m)
        console.log('[TripMapPage] hazard warnings for', m.size, 'stop(s)')
      })
      .catch(err => {
        console.warn('[TripMapPage] hazard fetch failed (no pills):', err?.message)
        setHazardsByStop(new Map())
      })
  }, [id, trip?.stops?.length, trip?.rigId])

  // FEAT-HERE-ROUTING (display) — the map line built DIRECTLY from HERE's full
  // per-leg polylines, concatenated in stop order. Null unless the flag is on, the
  // Maps SDK is loaded, AND every leg has a HERE polyline (an all-or-nothing guard
  // so we never draw a Frankenstein line with straight-line gaps where a leg is
  // missing). When non-null it OWNS routePath; null → Google computeRoutes draws
  // the line (unchanged). Keyed off hereLine + the coord-stop set.
  const hereLinePath = useMemo<google.maps.LatLng[] | null>(() => {
    if (!USE_HERE_ROUTING_DISPLAY || !isLoaded || !window.google?.maps) return null
    const cs = (trip?.stops ?? [])
      .filter(s => s.latitude && s.longitude)
      .sort((a, b) => a.order - b.order)
    if (cs.length < 2) return null
    if (!cs.slice(1).every(s => (hereLine.get(s.id)?.length ?? 0) >= 2)) return null
    const pts: google.maps.LatLng[] = []
    for (let i = 1; i < cs.length; i++) {
      for (const [lat, lng] of hereLine.get(cs[i].id)!) pts.push(new window.google.maps.LatLng(lat, lng))
    }
    return pts.length >= 2 ? pts : null
  }, [hereLine, trip?.stops, isLoaded])

  // When HERE owns the line, push it to routePath. (A separate effect, so it
  // re-asserts over any late-resolving Google computeRoutes setRoutePath below.)
  useEffect(() => {
    hereOwnsLineRef.current = !!hereLinePath
    if (hereLinePath) setRoutePath(hereLinePath)
  }, [hereLinePath])

  // ── Routes API (replaces deprecated DirectionsService) ────────────────────────
  useEffect(() => {
    if (!isLoaded || geocoding || !trip?.stops?.length) return
    const coordStops = trip.stops
      .filter(s => s.latitude && s.longitude)
      .sort((a, b) => a.order - b.order)
    if (coordStops.length < 2) return

    // The map LINE is no longer drawn from this Google route when HERE owns it
    // (hereLinePath set) — see the guard on setRoutePath below. This call still
    // runs for the per-leg highway NAMES + durations (HERE doesn't provide those),
    // and as the line FALLBACK when HERE geometry is absent. Intermediates are the
    // plain middle stops again (the via-waypoint approach caused the hooks this
    // build removes). `here:` in the key re-runs it once when HERE data lands so
    // the distance below switches to HERE's measurement.
    const useHereLine = !!hereLinePath
    const key = coordStops.map(s => `${s.latitude},${s.longitude}`).join('|') +
      (useHereLine ? `|here:${hereDist.size}` : '')
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

        // Decode the overall polyline and draw the route line — ONLY when HERE
        // isn't drawing it. When useHereLine, the HERE-polyline effect owns
        // routePath; skipping here avoids a flash of Google's line + a race.
        const encoded: string = route.polyline?.encodedPolyline
        console.log('[TripMapPage] encoded polyline length:', encoded?.length ?? 0)
        if (!useHereLine && !hereOwnsLineRef.current && encoded && window.google.maps.geometry?.encoding) {
          setRoutePath(window.google.maps.geometry.encoding.decodePath(encoded))
        }

        // Extract real highway names, durations, and distances per leg; persist to each destination stop
        const legs: any[] = route.legs ?? []
        console.log('[TripMapPage] legs count:', legs.length, '| expected:', coordStops.length - 1)
        let totalDistanceMeters = 0
        let totalLegMiles = 0
        legs.forEach((leg, i) => {
          const destStop = coordStops[i + 1]
          if (!destStop || !id) return
          const label = `leg[${i}] → ${destStop.locationName}`
          const highways      = parseHighwaysFromRouteSteps(leg.steps ?? [], label)
          const driveDuration = formatDuration(leg.duration ?? '')
          // Prefer HERE's measured distance (matches the HERE line being drawn);
          // fall back to Google's leg distance when HERE has none for this leg.
          const distMeters: number = (useHereLine ? hereDist.get(destStop.id) : undefined) ?? leg.distanceMeters ?? 0
          const driveDistanceMiles = distMeters > 0 ? Math.round(distMeters / 1609.34) : undefined
          totalDistanceMeters += distMeters
          totalLegMiles += driveDistanceMiles ?? 0
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

        // Sum all leg distances → update trip.totalMiles in DB. PR-3: sum the
        // WHOLE-MILE legs (what each stop stores), not raw meters — so this,
        // the server's recompute (syncTripEndpoints) and every page that sums
        // stop.driveDistanceMiles agree to the mile.
        if (totalDistanceMeters > 0 && id) {
          const totalMiles = totalLegMiles > 0 ? totalLegMiles : Math.round(totalDistanceMeters / 1609.34)
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
  }, [isLoaded, geocoding, trip?.stops, hereLinePath, hereDist])

  // ── Derived values ─────────────────────────────────────────────────────────────
  const stopsWithCoords = useMemo(
    () => trip?.stops?.filter(s => s.latitude && s.longitude).sort((a, b) => a.order - b.order) ?? [],
    [trip?.stops]
  )

  // ── Initial framing: fit ALL stops + the driving route in view ────────────────
  // Placed here (after stopsWithCoords useMemo) so all referenced variables are
  // declared before this effect. The effect was originally written above
  // stopsWithCoords, which caused a TDZ crash on every mount — move-only fix.
  // Replaces the old fixed zoom={6} / center-on-first-stop framing (those props now
  // only serve as the pre-load placeholder + the no-coords US-center fallback). We
  // build a LatLngBounds over every stop AND every point of the road-snapped route
  // polyline (so curved legs near the edges aren't clipped) and fitBounds with
  // padding. Re-runs whenever the stop set or the route geometry changes.
  // NOTE: this is separate from the stop-click panTo/panBy popup camera move — that
  // stays as-is and is still wanted.
  useEffect(() => {
    if (!mapInstance) return

    // No coords at all → leave the center/zoom props' US-center fallback untouched.
    if (stopsWithCoords.length === 0) return

    // Degenerate: a single stop (or all stops at coincident coords — e.g. a
    // start === return-home loop) yields a zero-size bounds that fitBounds would
    // blow up to max zoom. Center on the point at a sane fixed zoom instead.
    if (stopsWithCoords.length < 2) {
      const s = stopsWithCoords[0]
      mapInstance.setCenter({ lat: s.latitude!, lng: s.longitude! })
      mapInstance.setZoom(10)
      return
    }

    const bounds = new window.google.maps.LatLngBounds()
    for (const s of stopsWithCoords) bounds.extend({ lat: s.latitude!, lng: s.longitude! })
    if (routePath) for (const pt of routePath) bounds.extend(pt)

    // All coords identical (multiple stops, same spot) → same degenerate case.
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      mapInstance.setCenter(bounds.getCenter())
      mapInstance.setZoom(10)
      return
    }

    // Pixel padding so edge pins aren't clipped at the container edge; a little
    // extra on top since the marker pins extend upward from their anchor.
    mapInstance.fitBounds(bounds, { top: 72, right: 60, bottom: 60, left: 60 })
  }, [mapInstance, stopsWithCoords, routePath])

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

  // Total drive miles for the sidebar footer + Stats card. Computed from each
  // leg's driveDistanceMiles where available, falling back to Haversine when
  // the Routes API hasn't populated that leg yet. Prefer this over
  // trip.totalMiles since it stays accurate during incremental route computes.
  const liveTotalMiles = useMemo(() => {
    const sorted = [...(trip?.stops || [])].sort((a, b) => a.order - b.order)
    return sorted.slice(1).reduce((sum, stop, i) => {
      const prev = sorted[i]
      const miles = stop.driveDistanceMiles
        ?? haversineMiles(prev.latitude, prev.longitude, stop.latitude, stop.longitude)
      return sum + miles
    }, 0)
  }, [trip?.stops])

  // Cost and booking stats — totalCost via the shared computeTripTotals
  // helper so the map page's "Est. cost" stat agrees with the itinerary's
  // stat-strip and Cost Breakdown to the dollar. Reads the live fuel
  // estimate from state (fetched in the useEffect above); falls back to
  // camp-only when the estimate hasn't loaded yet or returned noEstimate.
  // Deliberately does NOT read trip.estimatedFuel — that was the stale
  // AI guess driving the prior inter-surface drift.
  const { totalCost, nonHomeStops, bookedStops } = useMemo(() => {
    const stops = trip?.stops || []
    // fuelPerLeg passed so the per-leg actual blend is in effect on the
    // map page too — totals match the itinerary's stat-strip when the
    // user has logged per-leg actuals.
    const totals = computeTripTotals(trip, {
      fuelEstimate: fuelEstimate?.noEstimate ? null : (fuelEstimate?.total ?? null),
      fuelPerLeg: fuelEstimate?.noEstimate ? null : (fuelEstimate?.perLeg ?? null),
    })
    // Badge-based: catches return-home loops where the closing stop is typed
    // DESTINATION but badged 'H'. Mirrors TripBookingPage's bookableStops so
    // the two pages report the same "X of Y" on the same trip.
    const nonHome = stops.filter((s: Stop) => !isHomeBadge(stopBadges[s.id]))
    const booked = nonHome.filter(s => s.bookingStatus === 'CONFIRMED').length
    return {
      totalCost: totals.hasAnyActuals ? totals.actualTotal : totals.plannedTotal,
      nonHomeStops: nonHome,
      bookedStops: booked,
    }
  }, [trip, fuelEstimate, stopBadges])

  // RIG-CHANGE Phase 2 — resolve the trip's CURRENT rig (assigned rigId, else the
  // user's default) and its length, then derive which BOOKED stops were stamped
  // against a SMALLER rig than the current one. Data-derived (not session state)
  // so the booked-fit banner + per-stop re-verify flags appear on plain page load
  // too, and clear automatically once nothing is undersized (e.g. swap back).
  const currentTripRig = useMemo<Rig | null>(() => {
    if (!rigs.length) return null
    return (trip?.rigId ? rigs.find(r => r.id === trip.rigId) : null)
      ?? rigs.find(r => r.isDefault)
      ?? null
  }, [rigs, trip?.rigId])
  const currentRigLength = currentTripRig?.length ?? null
  const BOOKED_STATUSES = ['CONFIRMED', 'PENDING', 'WAITLISTED']
  const undersizedBookedStops = useMemo(() => {
    if (currentRigLength == null) return []
    return (trip?.stops || []).filter(s =>
      BOOKED_STATUSES.includes(s.bookingStatus) &&
      s.bookedForRigLength != null &&
      s.bookedForRigLength < currentRigLength,
    )
  }, [trip?.stops, currentRigLength])

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

    // Pre-pass: cluster stops that share coordinates and assign each a
    // pixel-offset from a fixed spiral pattern. Index 0 (the first stop in
    // trip order at a given point) stays at the true coords; index 1+ get
    // visible offsets so they aren't buried under the index-0 marker. The
    // offset is applied only to the marker's content div via CSS transform —
    // the AdvancedMarkerElement's `position` stays at the true lat/lng so
    // the popup anchor logic at the OverlayViewF render is unaffected.
    //
    // combinedSH already merges the round-trip start/home pair as a
    // deliberate UX decision; the would-be-skipped last stop is excluded
    // from the cluster scan so we don't waste an offset slot on a marker
    // that will never render.
    const SPIRAL_OFFSETS: Array<{ x: number, y: number }> = [
      { x: 0,   y: 0   }, // index 0 — true coords
      { x: 18,  y: 0   }, // right
      { x: 0,   y: 18  }, // down
      { x: -18, y: 0   }, // left
      { x: 0,   y: -18 }, // up
      { x: 18,  y: 18  }, // diag
    ]
    const stopOffsets = new Map<string, { x: number, y: number }>()
    type Cluster = { lat: number, lng: number, members: string[] }
    const clusters: Cluster[] = []
    for (const s of stopsWithCoords) {
      const isFirstStop = s.id === firstStop?.id
      const isLastStop  = s.id === lastStop?.id
      if (combinedSH && isLastStop && !isFirstStop) continue
      const lat = s.latitude!, lng = s.longitude!
      const existing = clusters.find(c => coordsMatch(c.lat, c.lng, lat, lng))
      if (existing) {
        existing.members.push(s.id)
      } else {
        clusters.push({ lat, lng, members: [s.id] })
      }
    }
    for (const c of clusters) {
      if (c.members.length < 2) continue
      c.members.forEach((id, i) => {
        stopOffsets.set(id, SPIRAL_OFFSETS[i] ?? { x: 0, y: 0 })
      })
    }

    stopsWithCoords.forEach(stop => {
      const isFirst = stop.id === firstStop?.id
      const isLast  = stop.id === lastStop?.id

      // When start and home-return share the same pin, skip the last stop entirely
      // and give the first stop the combined 'S/H' badge instead.
      if (combinedSH && isLast && !isFirst) return

      // Combined-marker case keeps the 'S/H' shape but renders as 'S/F' to
      // match the "Start · Finish" label and the H→F transform applied to
      // every other endpoint marker.
      const badge = combinedSH && isFirst ? 'S/F' : formatStopBadgeMarker(stopBadges[stop.id])
      // Endpoint stops (start, return-home, or one-way finish) all share the
      // 'home' orange color so the trip's two anchors are visually distinct
      // from the destinations between them. classifyStop only knows about
      // stop.type === 'HOME', so override it here using the badge — which
      // already encodes endpoint semantics correctly (loop trips end with
      // type=DESTINATION at the home city, badged 'H'; one-way trips end
      // with badge 'F').
      const rawBadge = stopBadges[stop.id]
      const isEndpoint = rawBadge === 'S' || rawBadge === 'H' || rawBadge === 'F'
      const kind: MarkerKind = isEndpoint ? 'home' : classifyStop(stop)

      // Layer-visibility gates retired with the Layers panel. Stops,
      // overnight markers, and incompatible markers all render
      // unconditionally now; HOME (start) was always-on anyway.

      console.log(
        `[TripMapPage] marker badge=${badge} "${stop.locationName}" kind=${kind}`,
        `lat=${stop.latitude} lng=${stop.longitude}`,
      )

      // Pixel offset from the cluster pre-pass above. Solo stops get { 0, 0 }.
      // Offset markers get a tiny zIndex bump so when their 26px icons clip
      // their co-located neighbors (offset is 18px), they paint cleanly on top.
      const offset = stopOffsets.get(stop.id) ?? { x: 0, y: 0 }
      const isOffset = offset.x !== 0 || offset.y !== 0
      const marker = new window.google.maps.marker.AdvancedMarkerElement({
        position: { lat: stop.latitude!, lng: stop.longitude! },
        map:      mapInstance,
        content:  makeMarkerContent(kind, badge, offset),
        title:    stop.locationName,
        zIndex:   KIND_Z[kind] + (isOffset ? 1 : 0),
      })
      marker.addListener('click', () => focusStop(stop))
      markersRef.current.push(marker)
    })

    console.log(`[TripMapPage] ${markersRef.current.length} marker(s) added to map`)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInstance, stopsWithCoords, stopBadges])

  // Cleanup markers on unmount
  useEffect(() => () => { markersRef.current.forEach(m => { m.map = null }) }, [])

  // ── Handlers ──────────────────────────────────────────────────────────────────
  async function handleUpdateNights(stopId: string, nights: number) {
    if (!id || nights < 1) return
    await tripsApi.updateStop(id, stopId, { nights })
    setTrip(prev => prev ? { ...prev, stops: prev.stops?.map(s => s.id === stopId ? { ...s, nights } : s) } : prev)
    setSelectedStop(prev => prev?.id === stopId ? { ...prev, nights } : prev)
  }

  // ── Sidebar stop delete (parity with Itinerary) ──────────────────────────────
  // handleSaveEditStop retired with the Edit Stop modal — see scout audit:
  // the modal's fields each had a canonical writer elsewhere (booking page
  // for campgroundName, inline notes editor for notes, inline nights
  // stepper for nights, Modify-with-AI for location/type), and locationName
  // edits silently desynced lat/lng/driveDistanceMiles from the displayed
  // string. Real-world data showed 0 of 51 stops on the active accounts
  // had been edited via the modal.

  // Step 1 of the manual-delete flow: queue the stop for confirmation.
  // ConfirmModal asks first and surfaces any cascading-delete warnings
  // (e.g. confirmed booking).
  async function requestDeleteStop(stop: Stop) {
    setDeleteError(null)
    // Deleting ANY stop (destination OR overnight) can leave a too-long merged drive
    // day. Measure it first; if the merged leg is over the cap (+grace), show the
    // over-cap warning modal (with real hours) instead of the plain delete confirm.
    // Any preview failure falls through to the normal confirm.
    if (id && !checkingLongLeg) {
      setCheckingLongLeg(true)
      try {
        const res = await tripsApi.longLegPreview(id, stop.id)
        if (res.data?.exceeds) {
          setLongDrivePrompt({
            stop,
            legHours: res.data.legHours,
            cap: res.data.cap,
            fromName: res.data.fromName,
            toName: res.data.toName,
          })
          return
        }
      } catch { /* fall through to the normal delete confirm */ }
      finally { setCheckingLongLeg(false) }
    }
    setPendingDeleteStop(stop)
  }

  // "Remove it anyway" — delete the stop WITH acknowledgeLongLeg so the server
  // records the merged leg as acknowledged and never auto-inserts an overnight on it.
  async function confirmKeepLongDrive() {
    if (!id || !longDrivePrompt) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await tripsApi.deleteStop(id, longDrivePrompt.stop.id, undefined, true)
      const res = await tripsApi.get(id)
      setTrip(res.data)
      setLongDrivePrompt(null)
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Could not remove the overnight. Please try again.'
      setDeleteError(message)
    } finally {
      setDeleting(false)
    }
  }

  // Step 2: user clicked Confirm. Fire the actual delete and surface the
  // server's structured error message (HOME_STOP_PROTECTED / MIN_STOPS_VIOLATION)
  // when the request is blocked — the modal stays open so the user sees why.
  async function confirmDeleteStop() {
    if (!id || !trip || !pendingDeleteStop) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await tripsApi.deleteStop(id, pendingDeleteStop.id)
      const res = await tripsApi.get(id)
      setTrip(res.data)
      setPendingDeleteStop(null)
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Could not delete the stop. Please try again.'
      setDeleteError(message)
    } finally {
      setDeleting(false)
    }
  }

  // Confirmation copy mirrors the Itinerary page's pattern. Booking warning
  // when applicable; journal warning skipped (would require an extra fetch).
  function buildDeleteConfirmMessage(stop: Stop): string {
    const parts = [`Remove ${stop.locationName} from your trip? This cannot be undone.`]
    if (stop.bookingStatus === 'CONFIRMED') {
      const cgName = stop.campgroundName ? ` at ${stop.campgroundName}` : ''
      parts.push(`This stop has a confirmed booking${cgName}. Deleting will remove the booking from your trip.`)
    }
    if (deleteError) parts.push(`\n${deleteError}`)
    return parts.join('\n\n')
  }

  // canDeleteStopFn retired with the Edit Stop modal (its sole consumer).
  // The row-level showDelete (computed inline in the stops list) carries
  // the same min-stops + HOME-guard logic.

  // ─── Header edit handlers ──────────────────────────────────────────────────
  //
  // handleRename — restored to its pre-3f8ed99 form. The pencil opens an
  // inline name editor (the renaming/setRenaming ternary on the trip-name
  // row); Enter or the ✓ button saves via tripsApi.update({ name }). Renames
  // are rare and the optimistic local update is enough — on-error revert is
  // intentionally minimal (the server's rejection alert is loud enough).
  //
  // commitStartDate / scheduleSave — debounced auto-save for the date-line
  // editor. tripsApi.shiftDates is the ONLY safe path for moving the trip
  // in time: the server cascades the delta to every stop's arrival/departure
  // date in a single transaction (server/src/controllers/trips.ts:576).
  // Routing via tripsApi.update with startDate would NOT cascade — that's
  // the live footgun flagged in the scout (TripUpdateSchema permits the
  // field but updateTrip doesn't call recomputeStopDates). DO NOT use that
  // path here.
  //
  // Debounce rationale: native <input type="date"> behavior varies across
  // browsers. Chrome/Edge/Firefox fire onChange once when the user commits
  // a date in the picker — easy case. iOS Safari uses a wheel picker that
  // fires onChange on every wheel tick; macOS Safari pre-Big-Sur falls back
  // to text input that fires onChange per keystroke. Both would otherwise
  // hit shiftDates dozens of times for one "real" selection. A 400ms
  // setTimeout, cleared on each onChange, collapses the stream into ONE
  // call that fires after the user pauses. Long enough to absorb the
  // wheel/keystroke streams, short enough to feel immediate.
  //
  // No-op guard: shiftDates fires only when the picked YMD differs from
  // the current effective anchor (trip.startDate, falling back to the
  // first stop's arrivalDate, mirroring the server's anchor probe at
  // trips.ts:587). The server short-circuits a zero-delta shift on its
  // own (returns the trip unchanged), but skipping the API call entirely
  // means no network round-trip on a no-op.
  //
  // Response shape: shiftDates returns the full trip with stops + journal
  // (mirrors tripsApi.get), so setTrip(res.data) is a complete hot-swap —
  // no separate refetch needed.

  async function handleRename() {
    const trimmed = tripNameInput.trim()
    if (!id || !trimmed || trimmed === trip?.name) { setRenaming(false); return }
    await tripsApi.update(id, { name: trimmed }).catch(() => {})
    setTrip(prev => prev ? { ...prev, name: trimmed } : prev)
    setRenaming(false)
  }

  async function commitStartDate(ymd: string) {
    if (!id || !ymd || savingDate) return
    // No-op guard: skip the API call if the picked date equals the trip's
    // current effective start. Picks during debounce can echo the same
    // value back when the user opens then closes the picker without
    // change; this prevents a wasted round-trip.
    const firstDatedStop = trip?.stops?.find(s => s.arrivalDate)
    const currentAnchor =
      parseTripDate(trip?.startDate) ?? parseTripDate(firstDatedStop?.arrivalDate)
    if (currentAnchor && toYmd(currentAnchor) === ymd) {
      setDateEditorOpen(false)
      return
    }
    setSavingDate(true)
    try {
      const res = await tripsApi.shiftDates(id, { newStartDate: ymd })
      setTrip(res.data)
      setDateEditorOpen(false)
    } catch (err) {
      console.error('Failed to shift trip dates', err)
      alert('Could not change the start date. Make sure your trip has at least one dated stop.')
    } finally {
      setSavingDate(false)
    }
  }

  function scheduleSave(ymd: string) {
    // Clear any pending save before queuing a new one — picker streams
    // (iOS wheel, Safari-text) collapse into a single trailing-edge call
    // 400ms after the user stops emitting onChange events.
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      void commitStartDate(ymd)
    }, 400)
  }

  function handleStartNow() {
    // Explicit user gesture — bypass the debounce and commit immediately.
    // No need to clear saveTimerRef here; commitStartDate's own savingDate
    // guard prevents a double-fire if a debounced save was already pending.
    void commitStartDate(toYmd(new Date()))
  }

  async function handleExportPdf() {
    if (downloadingPdf || !trip) return
    setDownloadingPdf(true)
    try {
      // Pro gate — pdfExport feature parity (same pattern as the packing-list
      // PDF). Free users 403 FEATURE_GATED here; the central axios interceptor
      // opens the paywall and the catch below bails without the error alert.
      // To ungate, delete this one call.
      await tripsApi.exportPdf(trip.id)

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

      // Dynamic import so the ~1.5MB @react-pdf/renderer chunk only loads on click.
      const [{ pdf }, { TripPDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('../../components/pdf/TripPDF'),
      ])
      const blob = await pdf(<TripPDF trip={trip} mapImageBase64={mapBlobUrl} fuelEstimate={fuelEstimate} />).toBlob()
      if (mapBlobUrl) URL.revokeObjectURL(mapBlobUrl)
      // Deliver: file-only Web Share on mobile (no blob URL leaks into the share
      // sheet as a phantom roamready.ai/<uuid> link), anchor-download on desktop.
      await sharePdfBlob(blob, `RoamReady-${trip.name || 'Trip'}-Itinerary.pdf`)
    } catch (err: any) {
      // FEATURE_GATED 403 → paywall already opened by the central interceptor;
      // skip the generic alert so the user isn't double-narrated.
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
        return
      }
      console.error('PDF export failed', err)
      alert('PDF generation failed. Please try again.')
    } finally {
      setDownloadingPdf(false)
    }
  }

  // Memoized so the {lat,lng} object reference stays stable across re-renders
  // when the underlying coords are unchanged. @react-google-maps/api's <GoogleMap>
  // calls map.setCenter whenever the `center` prop reference changes, which would
  // otherwise snap the user back to the first stop's coords on every state update
  // (popup close, layer toggle, etc.). Deps are the bare lat/lng so we only
  // produce a new reference when the first stop's coords actually move.
  const firstStopLat = stopsWithCoords[0]?.latitude
  const firstStopLng = stopsWithCoords[0]?.longitude
  const center = useMemo(
    () =>
      firstStopLat != null && firstStopLng != null
        ? { lat: firstStopLat, lng: firstStopLng }
        : { lat: 39.5, lng: -98.35 },
    [firstStopLat, firstStopLng],
  )

  // C3 — colorForStop() removed. Its only consumer was the sidebar stops
  // list marker, which now uses an inline pale RV-blue / pale gold palette
  // tied to stop.type rather than the KIND_COLOR map (which still drives
  // the map markers themselves elsewhere in this file).

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div
      className="-mx-4 -mb-6 -mt-2 md:-mt-6"
      style={isDesktop ? { height: 'calc(100dvh - 4rem)', display: 'flex', flexDirection: 'column', minHeight: 0 } : undefined}
    >

      {/* Breadcrumb strip */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100 px-4 py-2 flex items-center gap-1.5">
        <Link to="/dashboard" className="text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors">Dashboard</Link>
        <span className="text-gray-300 text-xs">›</span>
        <span className="text-xs text-gray-700 font-medium truncate max-w-[200px]">{trip?.name ?? '…'}</span>
      </div>

      {/* Action tab bar — Journal, Packing list, Share, PDF.
          Itinerary tab intentionally absent: the yellow "View itinerary ›"
          button in the Map sidebar (commit 899cb4e) is the canonical way to
          reach the Itinerary route from this page, so the tab would be
          redundant. Tab bar lives only on this page; other trip pages
          render their own layouts. */}
      {/* Action row uses the canonical button classes so it matches the
          itinerary page (TripSummaryPage) exactly: three btn-outline secondary
          actions + one btn-primary PDF. Container stays flex-wrap gap-2 so the
          buttons wrap cleanly on narrow screens. Behavior unchanged — only the
          classNames conform to the shared button system. */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100 px-2 py-2 flex flex-wrap items-center gap-2">
        <Link
          to={`/trips/${id}/journal`}
          className="btn-outline text-sm flex items-center gap-1.5"
        >
          <BookOpen size={13} /> Trip Journal
        </Link>
        <Link
          to={`/packing/${id}`}
          className="btn-outline text-sm flex items-center gap-1.5"
        >
          <Package size={13} /> Packing list
        </Link>
        <button
          onClick={() => setShareOpen(true)}
          disabled={!trip}
          className="btn-outline text-sm flex items-center gap-1.5"
        >
          <Share2 size={13} /> Share
        </button>
        {/* FEAT-NAV-HANDOFF — whole trip in a maps app (all stops as waypoints). */}
        {trip?.stops && trip.stops.length >= 2 && (
          <WholeTripButton stops={trip.stops.slice().sort((a, b) => a.order - b.order)} tripId={id} />
        )}
        <button
          onClick={handleExportPdf}
          disabled={downloadingPdf}
          className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-60"
        >
          <Download size={13} /> {downloadingPdf ? 'Generating...' : 'PDF'}
        </button>
        {/* Report an issue — opens the global feedback modal pre-tagged with this
            trip so the admin can deep-link straight into the session inspector. */}
        <button
          onClick={() => useUIStore.getState().openFeedbackModal('BUG_REPORT', { tripId: id, tripName: trip?.name })}
          className="btn-outline text-sm flex items-center gap-1.5"
        >
          <Flag size={13} /> Report an issue
        </button>
        {/* BUG-ITINERARY-BTN-FOLD — itinerary CTA in the action row, MOBILE ONLY.
            Gold/solid (btn-primary IS #F7A829, same as PDF) + active state; sized
            via btn-primary so it wraps cleanly in this flex-wrap row. Mobile only
            (the in-sidebar !isMobile CTA stays the canonical one on desktop/tablet
            — one CTA per breakpoint, no duplicate). Gated on nonHomeStops. */}
        {isMobile && nonHomeStops.length > 0 && (
          <Link
            to={`/trips/${id}/itinerary`}
            className="btn-primary text-sm flex items-center gap-1.5 active:bg-[#8A5A0E]"
          >
            View itinerary ›
          </Link>
        )}
      </div>

      {/* ── Map + sidebar row ─────────────────────────────────────────────────── */}
      {/* Wrapper provides the reference height that expandMap() reads */}
      <div style={isDesktop ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : undefined}>
      <div
        ref={mapRowRef}
        className={isMobile ? 'flex flex-col' : 'flex items-start'}
        style={isDesktop ? {
          transition: 'height 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          flex: 1,
          minHeight: 0,
        } : {
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
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
            {/* Header: trip name + rename + close. C1 — trip name typography
                bumped to 15px / weight 500 / line-height 1.3 to anchor the
                redesigned sidebar header. Rename input matches for visual
                continuity across the rename state. */}
            <div className="p-4 border-b border-gray-100 flex-shrink-0" style={{ borderBottomWidth: '0.5px' }}>
              {/* Trip name + rename pencil + (desktop) close-sidebar. Pencil
                  is name-only — date editing lives on the clickable date
                  line directly below this row. Two affordances, two scopes:
                  pencil = rename, date line = dates. */}
              <div className="flex items-start gap-2">
                {renaming ? (
                  <div className="flex-1 flex items-center gap-1 min-w-0">
                    <input
                      className="flex-1 min-w-0 font-medium text-gray-900 border border-[#1F6F8B] rounded px-2 py-1 focus:outline-none"
                      style={{ fontSize: 15, lineHeight: 1.3 }}
                      value={tripNameInput}
                      onChange={e => setTripNameInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename()
                        if (e.key === 'Escape') setRenaming(false)
                      }}
                      autoFocus
                    />
                    <button onClick={handleRename} className="p-1 text-[#1F6F8B] hover:bg-[#E0F0F4] rounded flex-shrink-0" aria-label="Save name">
                      <Check size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center gap-1 min-w-0">
                    <h2
                      className="font-medium text-gray-900 truncate"
                      style={{ fontSize: 15, lineHeight: 1.3 }}
                    >
                      {trip?.name}
                    </h2>
                    <button
                      onClick={() => { setTripNameInput(trip?.name || ''); setRenaming(true) }}
                      className="p-1 hover:bg-gray-100 rounded flex-shrink-0"
                      title="Rename trip"
                      aria-label="Rename trip"
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

              {/* First-class trip date line ─ clickable row that's either the
                  trip's "May 27 – Jun 10" range (when set) or a "Set start
                  date" prompt (when unset). Click toggles dateEditorOpen and
                  the same wrapper inflates into an inline editor (no popover
                  → no clipping risk against the sidebar's overflow:hidden).

                  Placement: directly under the trip-name row and above the
                  status pill. Date is the cause, status is the derived
                  effect (deriveTripStatus runs against today vs these
                  dates) — name → when → status reads naturally. */}
              <div ref={dateLineWrapperRef} className="mt-2">
                {(() => {
                  if (!trip) return null
                  // hasStopDates mirrors the server's anchor probe at
                  // shiftTripDates (trips.ts:587): without it the shift
                  // endpoint 400s. We disable input + Start now in the
                  // editor when this is false rather than letting the user
                  // submit into a guaranteed error.
                  const hasStopDates = trip.stops?.some(s => s.arrivalDate != null) ?? false
                  const firstDatedStop = trip.stops?.find(s => s.arrivalDate)
                  const anchor =
                    parseTripDate(trip.startDate) ?? parseTripDate(firstDatedStop?.arrivalDate)
                  const hasDates = !!anchor
                  const todayYmd = toYmd(new Date())
                  const isPastDate = !!startDateInput && startDateInput < todayYmd
                  // User-facing count (excludes HOME origin + return-home stop)
                  // — see userFacingStopCount.
                  const stopCount = userFacingStopCount(trip.stops)
                  const nightsLabel = trip.totalNights
                    ? `${trip.totalNights} night${trip.totalNights !== 1 ? 's' : ''}`
                    : null

                  // Date picker is now a click-to-open popover, not an inline
                  // expansion. The closed state's footprint is the same whether
                  // the popover is open or shut — the popover overlays content
                  // below (position: absolute) instead of pushing layout. Save
                  // wiring is unchanged: onSelect → setStartDateInput →
                  // scheduleSave → commitStartDate → tripsApi.shiftDates. The
                  // only new step is setDateEditorOpen(false) inside onSelect
                  // so the popover auto-closes after a pick. The outside-click
                  // handler at L581-599 (composedPath shadow-DOM fix from
                  // 248753a) still treats every descendant of dateLineWrapperRef
                  // — including the absolutely-positioned popover — as "inside",
                  // so opening or picking doesn't get misread as outside-click.
                  const selectedDate = parseTripDate(startDateInput) ?? undefined
                  const defaultMonth = parseTripDate(startDateInput) ?? anchor ?? new Date()
                  const today = new Date()
                  const calStart = new Date(today.getFullYear() - 1, 0, 1)
                  const calEnd   = new Date(today.getFullYear() + 5, 11, 31)
                  return (
                    <>
                      {/* Trigger row + anchor for the floating popover */}
                      <div className="relative">
                        <div className="flex items-center gap-2">
                          {hasDates ? (
                            <button
                              type="button"
                              onClick={() => {
                                setStartDateInput(toYmd(anchor!))
                                setDateEditorOpen(o => !o)
                              }}
                              disabled={savingDate}
                              className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-[#F2F8FA] hover:bg-[#E0F0F4] text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Edit trip start date"
                            >
                              <Calendar size={13} className="text-[#1F6F8B] flex-shrink-0" />
                              <span className="text-sm text-gray-700 truncate">
                                {formatTripDate(anchor!, 'MMM d, yyyy')}
                              </span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setStartDateInput('')
                                setDateEditorOpen(o => !o)
                              }}
                              disabled={savingDate}
                              className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-dashed border-gray-300 hover:border-[#1F6F8B] hover:text-[#1F6F8B] text-left text-gray-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Set the trip's start date"
                            >
                              <CalendarPlus size={13} className="flex-shrink-0" />
                              <span className="text-sm">Set start date</span>
                            </button>
                          )}
                          {/* Start now — a date-shift shortcut ("move the trip to
                              start today"), only meaningful for a trip that hasn't
                              started yet. Gated on derived PLANNING so it doesn't
                              linger on active/completed trips (the stale-"Start now"
                              bug). Also suppressed when there are no stop dates
                              because shiftDates would 400 without an anchor
                              (mirrors trips.ts:587). */}
                          {hasStopDates && deriveTripStatus(trip) === 'PLANNING' && (
                            <button
                              onClick={handleStartNow}
                              disabled={savingDate}
                              className="text-xs text-[#1F6F8B] hover:underline disabled:opacity-50 disabled:no-underline flex-shrink-0"
                              title="Shift the trip to start today"
                            >
                              Start now
                            </button>
                          )}
                        </div>

                        {/* Floating popover — positioned below the trigger row,
                            z-30 so it overlays sibling content (status pill,
                            stops list) instead of pushing layout. Sits inside
                            dateLineWrapperRef so the composedPath outside-click
                            handler treats it as "inside" — clicks on day cells
                            and dropdown navigation don't cancel the pending
                            save. The desktop sidebar's overflow:hidden (used
                            for its width animation) clips horizontally at the
                            sidebar's right edge; the DayPicker's ~250px width
                            fits comfortably within the 24rem - 2rem padding. */}
                        {dateEditorOpen && (
                          <div
                            className="absolute top-full left-0 mt-1 z-30 rounded-md border border-[#E8E4DA] bg-white shadow-lg p-2"
                            style={{
                              ['--rdp-accent-color' as any]: '#1F6F8B',
                              ['--rdp-accent-background-color' as any]: '#E0F0F4',
                              ['--rdp-background-color' as any]: '#F5F4F2',
                              ['--rdp-day-height' as any]: '32px',
                              ['--rdp-day-width' as any]: '32px',
                            }}
                          >
                            {!hasStopDates ? (
                              <p className="text-xs text-gray-500 italic px-1 py-2">
                                Add stops first to set a trip date.
                              </p>
                            ) : (
                              <div className={savingDate ? 'opacity-50 pointer-events-none' : ''}>
                                <DayPicker
                                  mode="single"
                                  selected={selectedDate}
                                  defaultMonth={defaultMonth}
                                  startMonth={calStart}
                                  endMonth={calEnd}
                                  captionLayout="dropdown"
                                  disabled={savingDate ? () => true : undefined}
                                  onSelect={(date) => {
                                    if (!date) return
                                    const ymd = toYmd(date)
                                    setStartDateInput(ymd)
                                    scheduleSave(ymd)
                                    setDateEditorOpen(false)
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Past-date warning + end-date caption. Live below the
                          closed date line (not inside the popover) so they
                          stay visible after the popover auto-closes on pick —
                          otherwise the user would never see the backdate
                          warning that the pick just triggered. */}
                      {isPastDate && (
                        <p className="text-[11px] text-[#BA7517] mt-1.5">
                          This will backdate the trip; status will read COMPLETED right away.
                        </p>
                      )}
                      {trip.endDate && (
                        <p className="text-[11px] text-gray-500 mt-2">
                          Ends {formatTripDate(trip.endDate, 'MMM d')}
                          {nightsLabel ? ` · ${nightsLabel}` : ''}
                          {stopCount ? `, ${stopCount} stop${stopCount === 1 ? '' : 's'}` : ''}.
                          {' '}
                          <span className="text-gray-400">
                            To change the end, remove a stop or adjust nights.
                          </span>
                        </p>
                      )}
                      {/* Quiet lifecycle stamp — when this trip plan was first
                          created (Trip.createdAt), distinct from the travel
                          dates above. Matches the Dashboard card's "Started
                          <date>" wording source. */}
                      {trip.createdAt && (
                        <p className="text-[11px] text-gray-400 mt-1">
                          Created {lifecycleDate(trip.createdAt)}
                        </p>
                      )}
                    </>
                  )
                })()}
              </div>

              {/* Status pill — Planning / Active / Completed. Sits between the
                  trip name and the slim stats line below. Status is derived
                  from the trip's committed dates vs today (utils/tripStatus.ts)
                  — no stored override, no manual flip. Planning was previously
                  silent here; restored for symmetry with the dashboard
                  TripCard, which has always shown a planning badge on every
                  card. The asymmetry (dashboard shows planning, trip page
                  didn't) made the trip-page header read as "empty" between
                  the date line and stats for future-dated trips. */}
              {(() => {
                if (!trip) return null
                const derived = deriveTripStatus(trip)
                const cls =
                  derived === 'ACTIVE'    ? 'badge-active' :
                  derived === 'COMPLETED' ? 'badge-completed' :
                                            'badge-planning'
                const label =
                  derived === 'ACTIVE'    ? 'Active' :
                  derived === 'COMPLETED' ? 'Completed' :
                                            'Planning'
                return (
                  <div className="mt-2">
                    <span className={cls}>{label}</span>
                  </div>
                )
              })()}

              {/* C1 — Slim stats line. Replaces the 4-card stats grid that
                  used to live at the bottom of this header block. Same data
                  sources (liveTotalMiles, trip.totalNights, totalCost via
                  computeTripTotals); the Booked card is gone — that count
                  moves into the "Book campgrounds (X/N)" CTA in C2. Each
                  piece is gated independently so a brand-new trip with no
                  routes computed yet doesn't render an orphan separator
                  with nothing inside it. */}
              {(() => {
                const milesValue = liveTotalMiles > 0 ? liveTotalMiles : (trip?.totalMiles ?? 0)
                const nightsValue = trip?.totalNights ?? 0
                const parts: string[] = []
                if (milesValue > 0) parts.push(`${milesValue.toLocaleString()} mi`)
                if (nightsValue > 0) parts.push(`${nightsValue} night${nightsValue !== 1 ? 's' : ''}`)
                if (totalCost > 0) parts.push(`est. $${Math.round(totalCost).toLocaleString()}`)
                if (parts.length === 0) return null
                return (
                  <p
                    className="text-gray-500 mt-3 pb-3 border-b border-gray-100"
                    style={{ fontSize: 12, lineHeight: 1.4, borderBottomWidth: '0.5px' }}
                  >
                    {parts.join(' · ')}
                  </p>
                )
              })()}

              {/* Action buttons stack. Two CTAs at the top establish the
                  user's primary actions on this page, both gold but using
                  solid/outline to communicate hierarchy:
                    1. View itinerary (gold solid) — most-frequent, top.
                    2. Book campgrounds (gold outline) — important, second.
                  The pre-C2 all-booked → pine-"Booked"-pill swap on the
                  View itinerary slot is intentionally NOT restored — Book
                  campgrounds carries the completion signal on its own pine-
                  outline variant now, and a second pine pill on the
                  itinerary slot would be a redundant duplicate. */}
              <div className="flex flex-col gap-2 mt-3">
                {/* View itinerary — gold solid, the most-frequent action on
                    this page (users return to review their day-by-day plan
                    repeatedly across the life of a trip). Restored to the
                    top of the stack from a brief C2 detour into the corner
                    tab bar — placement there demoted it too far.
                    !isMobile (BUG-ITINERARY-BTN-FOLD): on mobile this CTA is
                    rendered as a top strip above the map instead (the in-sidebar
                    one sits below the fold on tall trips); gating here keeps
                    it to ONE CTA on mobile. Tablet/desktop keep it in-sidebar. */}
                {!isMobile && nonHomeStops.length > 0 && (
                  <Link
                    to={`/trips/${id}/itinerary`}
                    className="bg-[#F7A829] text-white hover:bg-[#C9851A] active:bg-[#8A5A0E] text-sm font-medium px-4 py-2.5 rounded-md text-center transition-colors"
                  >
                    View itinerary ›
                  </Link>
                )}

                {/* C2 — Book campgrounds CTA. Gold outline matching the
                    booking page's Book button vocabulary so the visual
                    language stays consistent across pages. Swaps to a pine-
                    outline "All campgrounds booked (N/N)" variant when every
                    bookable stop has bookingStatus: 'CONFIRMED' — preserves
                    the completion-state signal commit ab17c1f introduced
                    on the prior pine "Booked" pill, now carried by this
                    CTA. Both variants route to /trips/:id/booking so the
                    user can revisit after completion to record actuals or
                    edit details. Denominator uses nonHomeStops.length —
                    the same isHomeBadge-filtered count the booking page
                    reports, so "X of Y" agrees across pages. */}
                {/* Both CTAs converted from inline-style to Tailwind classes so
                    the hover state applies. Previous shape had color / border /
                    background set inline alongside a Tailwind hover:bg-[...]
                    class; inline styles win on specificity, so the hover rule
                    was generated but never overrode the inline `background:
                    transparent`. Matches the styling pattern of the other
                    action-stack outline buttons (Modify trip with AI, Start
                    trip, Mark completed), which is exactly why their hovers
                    worked and these two didn't. */}
                {nonHomeStops.length > 0 && (
                  bookedStops === nonHomeStops.length ? (
                    <Link
                      to={`/trips/${id}/booking`}
                      className="flex items-center justify-center gap-1.5 transition-colors text-[#2F4030] border border-[#3E5540] bg-transparent hover:bg-[#DCE5D5] text-sm font-medium px-[14px] py-[9px] rounded-md"
                    >
                      <CheckCircle size={15} />
                      All campgrounds booked ({nonHomeStops.length}/{nonHomeStops.length})
                    </Link>
                  ) : (
                    <Link
                      to={`/trips/${id}/booking`}
                      className="flex items-center justify-center gap-1.5 transition-colors text-[#BA7517] border border-[#BA7517] bg-transparent hover:bg-[#FAEEDA] text-sm font-medium px-[14px] py-[9px] rounded-md"
                    >
                      <Tent size={15} />
                      Book campgrounds ({bookedStops}/{nonHomeStops.length})
                    </Link>
                  )
                )}

                {/* Modify trip with AI — primary planning affordance and the
                    most frequent action in the sidebar. The previous
                    Start trip / Mark completed buttons that lived below it
                    are gone: status is now derived from the trip's committed
                    dates vs today (utils/tripStatus.ts), so there's no phase
                    button for the user to click. The Active / Completed pill
                    above the stats line is the read-only signal. */}
                <button
                  onClick={() => setModifyPanelOpen(true)}
                  className="border border-[#1F6F8B] text-[#1F6F8B] bg-white hover:bg-[#E0F0F4] text-sm font-medium px-4 py-2.5 rounded-md transition-colors flex items-center justify-center gap-1.5"
                >
                  <Wand2 size={13} /> Modify trip with AI
                </button>

                {/* RIG-CHANGE Phase 2 — "Rig for this trip" selector. Only when
                    the user has at least one profile rig to choose from. On a
                    swap it refreshes the trip (fit/labels/banner) and the fuel
                    estimate (trip.id is unchanged so the fuel effect won't re-run
                    on its own). A larger swap surfaces the warning inside the
                    selector; the persistent booked-fit banner is data-derived below. */}
                {id && trip && rigs.length > 0 && (
                  <TripRigSelector
                    tripId={id}
                    rigs={rigs}
                    currentRigId={trip.rigId ?? null}
                    onSwapped={fresh => {
                      setTrip(fresh)
                      tripsApi.getFuelEstimate(id)
                        .then(res => setFuelEstimate(res.data))
                        .catch(() => {})
                    }}
                  />
                )}
                {/* FEAT-TRIP-DRIVE-CAP — a daily drive limit the user stated in
                    chat for THIS trip (overrides the profile cap). Visible so
                    the override is never a surprise; × clears it back to the
                    profile setting (raising the cap never needs a recheck). */}
                {id && trip && trip.maxDriveHours != null && trip.maxDriveHours > 0 && (
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[#1F6F8B]/30 bg-[#1F6F8B]/5 px-2.5 py-1 text-[11px] text-[#134756]">
                    <span className="font-medium">Drive limit: {trip.maxDriveHours}h/day</span>
                    <span className="text-[#1F6F8B]/70">for this trip</span>
                    <button
                      type="button"
                      aria-label="Clear the drive limit for this trip"
                      title="Clear — go back to your profile's drive limit"
                      className="ml-0.5 -my-2 -mr-1.5 inline-flex h-8 w-8 items-center justify-center rounded-full text-base leading-none text-[#1F6F8B]/70 hover:text-[#134756] hover:bg-[#1F6F8B]/10"
                      onClick={async () => {
                        try {
                          await tripsApi.update(id, { maxDriveHours: null })
                          const fresh = (await tripsApi.get(id)).data
                          setTrip(fresh)
                        } catch (err) {
                          console.error('[drive-cap] clear failed', err)
                        }
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>

              {/* C1 — 4-card stats grid removed. Miles + Nights + Est. cost
                  moved up into the slim stats line above the action stack;
                  Booked moves into the "Book campgrounds (X/N)" CTA in C2. */}
            </div>

            {/* Layers panel removed — see the comment on the (now-retired)
                layers state earlier in this file. Map markers and polylines
                render unconditionally. */}

            {/* Stops / Weather tab bar */}
            <div className="flex border-b border-gray-100 flex-shrink-0" style={{ borderBottomWidth: '0.5px' }}>
              <button
                onClick={() => setSidebarTab('stops')}
                className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  sidebarTab === 'stops'
                    ? 'border-[#1F6F8B] text-[#1F6F8B]'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Stops ({userFacingStopCount(trip?.stops)})
              </button>
              <button
                onClick={() => setSidebarTab('weather')}
                className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 -mb-px flex items-center justify-center gap-1 ${
                  sidebarTab === 'weather'
                    ? 'border-[#1F6F8B] text-[#1F6F8B]'
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

            {/* Tab content — scrollable. Desktop: bounded flex child with its own
                scrollbar so only the stops list scrolls while the header + tab bar
                stay pinned (minHeight:0 is mandatory for overflow to engage).
                Mobile/tablet: unstyled, normal full-page scroll. */}
            <div
              className="p-3 pb-20 lg:pb-3"
              style={isDesktop ? { flex: 1, minHeight: 0, overflowY: 'auto' } : undefined}
            >
              {sidebarTab === 'stops' && (
                <div className="space-y-0.5">
                  {/* FEAT-RIG-AWARE-INDICATOR — one trip-level line (mock Option D).
                      States: BLUE nudge (rig has no safety dims — an invitation, not
                      a warning); GREEN (every provenance-carrying leg was truck-
                      routed); AMBER count (mixed — the flagged stop(s) wear the
                      amber pill above); AMBER all-car. Gated on the same display
                      flag as the routes fetch, and renders NOTHING when no
                      provenance arrived (legacy trips, fetch failure) — the line
                      never claims what the data can't back. */}
                  {(() => {
                    if (!USE_HERE_ROUTING_DISPLAY) return null
                    const rigAny: any = currentTripRig
                    // RIG-REASON (2026-09-05): rig-aware routing needs ALL of height,
                    // length and weight (GVWR). Benny's Thor Magnitude had height +
                    // length but no GVWR, so every drive fell back and the sidebar
                    // just said "not planned for your rig" with no way to fix it.
                    // Name exactly what is missing and link to the rig form.
                    const missing: string[] = []
                    if (!rigAny || !((rigAny.height ?? 0) > 0)) missing.push('height')
                    if (!rigAny || !((rigAny.length ?? 0) > 0)) missing.push('length')
                    if (!rigAny || !((rigAny.gvwr ?? 0) > 0)) missing.push('weight (GVWR)')
                    if (missing.length) {
                      const list = missing.length === 1 ? missing[0] : missing.length === 2 ? `${missing[0]} and ${missing[1]}` : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
                      return (
                        <div className="mx-2 mb-2 flex items-start gap-1.5 rounded-md border border-rr-blue-100 bg-rr-blue-50 px-2.5 py-1.5 text-xs text-gray-700">
                          <Info size={14} className="flex-shrink-0 mt-px text-rr-blue" />
                          <span>
                            {rigAny ? `We can't plan drives for the ${rigAny.name ?? 'rig'} without its ${list}. ` : 'No rig on this trip yet. '}
                            <Link
                              to={rigAny ? `/profile/rig/${rigAny.id}/edit?returnTo=/trips/${id}/map` : '/profile/rig'}
                              className="font-semibold text-rr-blue hover:text-rr-blue-dark underline"
                            >{rigAny ? `Add the ${list}` : 'Add your rig'}</Link>
                            {' '}and this trip's drives will be re-planned for it.
                          </span>
                        </div>
                      )
                    }
                    const vals = [...rigAwareByStop.values()]
                    const total = vals.length
                    if (total === 0) return null
                    const fallback = vals.filter(v => v === false).length
                    const measured = total - fallback
                    // SIDEBAR-READABILITY: the summary is a green or amber banner
                    // (12px, filled) instead of an 11px text line; the amber copy
                    // leads with NOT so nobody reads "car routing" as a feature.
                    if (fallback === 0) {
                      return (
                        <div className="mx-2 mb-2 flex items-center gap-1.5 rounded-md border border-rr-pine-100 bg-rr-pine-50 px-2.5 py-1.5 text-xs font-semibold text-rr-pine-700">
                          <Check size={14} className="flex-shrink-0 text-rr-pine" />
                          <span>{total === 1 ? 'Drive planned for your rig' : 'All drives planned for your rig'}</span>
                        </div>
                      )
                    }
                    if (measured === 0) {
                      return (
                        <div className="mx-2 mb-2 flex items-start gap-1.5 rounded-md border border-rr-gold-100 bg-rr-gold-50 px-2.5 py-1.5 text-xs font-semibold text-rr-gold-700">
                          <AlertTriangle size={14} className="flex-shrink-0 mt-px text-rr-gold-dark" />
                          <span>{total === 1 ? 'This drive is not planned for your rig' : 'No drive on this trip is planned for your rig'} — check clearances and grades yourself.</span>
                        </div>
                      )
                    }
                    return (
                      <div className="mx-2 mb-2 flex items-start gap-1.5 rounded-md border border-rr-gold-100 bg-rr-gold-50 px-2.5 py-1.5 text-xs font-semibold text-rr-gold-700">
                        <AlertTriangle size={14} className="flex-shrink-0 mt-px text-rr-gold-dark" />
                        <span>{fallback} of {total} drives not planned for your rig — check the flagged drive{fallback > 1 ? 's' : ''} yourself.</span>
                      </div>
                    )
                  })()}
                  {/* RIG-CHANGE Phase 2 — booked-fit warning banner. Mirrors the
                      weather-alerts banner (amber tokens). Data-derived: shows
                      whenever a booked stop was stamped against a rig SHORTER than
                      the current trip rig; clears automatically once none are
                      undersized. Informational only — no dismiss, no reservation
                      change (Pine stays exclusively on the booked status pill). */}
                  {undersizedBookedStops.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 mb-2">
                      <p className="text-[10px] font-semibold text-amber-800 mb-1.5 flex items-center gap-1">
                        <AlertTriangle size={11} className="flex-shrink-0" />
                        {undersizedBookedStops.length} booked site{undersizedBookedStops.length === 1 ? '' : 's'} may not fit your current rig
                      </p>
                      <div className="space-y-1">
                        {undersizedBookedStops.map(s => (
                          <div key={s.id} className="border border-amber-200 bg-white rounded px-2 py-1 text-[10px] text-amber-800 leading-snug">
                            {s.locationName} — booked for {s.bookedForRigName} ({s.bookedForRigLength} ft). Call the campground to confirm it fits your current rig. We won't change your reservation.
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(() => {
                    const sortedStops = trip?.stops?.slice().sort((a, b) => a.order - b.order) ?? []
                    return sortedStops.map((stop, i) => {
                    const badge      = stopBadges[stop.id]
                    const isEndpoint = badge === 'S' || badge === 'H' || badge === 'F'
                    // C3 — isEndpointMarker removed. The prior usage drove the
                    // sidebar marker's orange home-color override; the new
                    // marker palette (markerBg/markerText below) covers
                    // endpoints with solid gray, so the duplicate flag is no
                    // longer needed. The map markers themselves continue to
                    // use isEndpoint via the marker-rendering path.
                    const hasAlert = stopHasAlerts(weatherData[stop.id])
                    const alerts   = stopAlerts(weatherData[stop.id])

                    // Delete affordance hidden on HOME stops AND when removing
                    // would leave the trip below the 2-stop floor (matches
                    // server guard 4). showEdit retired with the Edit Stop
                    // modal — pencil icon no longer rendered on this row.
                    const showDelete = stop.type !== 'HOME' && sortedStops.length > 2

                    // Subtitle layout:
                    //   Start (badge 'S'):       single line "Start" — no previous stop, no mileage
                    //   Finish (badge 'H'/'F'):  two lines — "Finish" on top, "N mi from Z" below.
                    //                            The closing leg is often the longest of the trip,
                    //                            so showing it is load-bearing. Second line omitted
                    //                            when driveDistanceMiles is null (same null-handling
                    //                            discipline as destination rows).
                    //   Destination:             single line, mileage appended inline.
                    // (SIDEBAR-READABILITY: the subtitle is now rendered inline below —
                    // miles / nights chip / per-drive rig line — from these two values.)
                    const prevStop = i > 0 ? sortedStops[i - 1] : undefined
                    const distMiles = stop.driveDistanceMiles

                    // C3 — Per-row CTA replacing the old read-only booking
                    // pill. Each non-endpoint state is a Link to the booking
                    // page at this stop's anchor; e.stopPropagation() keeps
                    // the card's setSelectedStop click intact for the rest
                    // of the row. Color matches the dot for each state so
                    // the at-a-glance scan and the actionable text speak
                    // the same language:
                    //   CONFIRMED   green dot + pine "Booked" pill (no link)
                    //   NOT_BOOKED  gray dot  + RV-blue "Book →" link
                    //   PENDING/WL  amber dot + amber "Pending →" link
                    //   CANCELLED   red dot   + red "Cancelled →" link
                    // Endpoint rows keep their existing Start/Finish text.
                    const ctaEl = isEndpoint ? (
                      <span className="text-[9px] text-gray-400">{formatStopBadgeLabel(badge)}</span>
                    ) : stop.bookingStatus === 'CONFIRMED' ? (
                      // Deep-link to this stop's reservation panel, mirroring the
                      // sibling status links below. stopPropagation so the click
                      // opens booking and does NOT also fire the row's setSelectedStop.
                      // The booking page already handles ?stopId= (active + scroll).
                      <Link
                        to={`/trips/${id}/booking?stopId=${stop.id}`}
                        onClick={e => e.stopPropagation()}
                        className="rounded-md font-medium whitespace-nowrap hover:underline transition-colors"
                        style={{
                          background: '#DCE5D5',
                          color: '#2F4030',
                          fontSize: 10,
                          padding: '2px 6px',
                        }}
                      >
                        Booked
                      </Link>
                    ) : (
                      <Link
                        to={`/trips/${id}/booking?stopId=${stop.id}`}
                        onClick={e => e.stopPropagation()}
                        className="hover:underline transition-colors whitespace-nowrap"
                        style={{
                          fontSize: 11,
                          color:
                            stop.bookingStatus === 'PENDING' || stop.bookingStatus === 'WAITLISTED' ? '#D97706'
                            : stop.bookingStatus === 'CANCELLED' ? '#EF4444'
                            : '#185FA5',
                        }}
                      >
                        {stop.bookingStatus === 'PENDING' || stop.bookingStatus === 'WAITLISTED' ? 'Pending →'
                          : stop.bookingStatus === 'CANCELLED' ? 'Cancelled →'
                          : 'Book →'}
                      </Link>
                    )

                    // C3 — booking-state dot. Always rendered (8×8) so endpoint
                    // and non-endpoint rows align at the same left edge; the
                    // endpoint dot is transparent (it's not a "booking state"
                    // concept for start/finish). Color matches the per-row
                    // CTA for visual coherence — green CONFIRMED, amber
                    // PENDING/WAITLISTED, red CANCELLED, gray NOT_BOOKED.
                    const dotColor = isEndpoint ? 'transparent'
                      : stop.bookingStatus === 'CONFIRMED' ? '#1D9E75'
                      : stop.bookingStatus === 'PENDING' || stop.bookingStatus === 'WAITLISTED' ? '#D97706'
                      : stop.bookingStatus === 'CANCELLED' ? '#EF4444'
                      : '#E8E4DA'

                    // C3 — marker circle palette swap. Pale RV-blue for
                    // overnight stops, pale gold for multi-night stays, solid
                    // gray for Start/Finish. Mirrors the booking page card
                    // headers' bubble colors so the icon language is uniform.
                    const markerBg = isEndpoint ? '#5F5E5A'
                      : stop.type === 'OVERNIGHT_ONLY' ? '#E0F0F4'
                      : '#FAEEDA'
                    const markerText = isEndpoint ? '#FFFFFF'
                      : stop.type === 'OVERNIGHT_ONLY' ? '#134756'
                      : '#854F0B'

                    // C3 — bed for overnight, tent for multi-night, nothing
                    // for endpoints. Same predicate the booking page sidebar
                    // uses so the language is identical across the two pages.
                    const showTent = !isEndpoint && stop.type !== 'OVERNIGHT_ONLY'

                    // Outer is a <div role="button"> rather than a <button> so
                    // the per-row Edit/Delete <button>s can nest inside without
                    // invalid HTML (button-in-button). Keyboard handlers wired
                    // for accessibility parity with the original button.
                    return (
                      <div
                        key={stop.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => focusStop(stop)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusStop(stop) } }}
                        className="w-full text-left flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#1F6F8B]/30"
                      >
                        {/* 8px booking-state dot — title'd so the color code
                            is hover-explained like the row's other glyphs. */}
                        <span
                          className="flex-shrink-0 rounded-full"
                          style={{ width: 8, height: 8, background: dotColor }}
                          title={isEndpoint ? undefined
                            : stop.bookingStatus === 'CONFIRMED' ? 'Booking confirmed'
                            : stop.bookingStatus === 'PENDING' ? 'Booking pending'
                            : stop.bookingStatus === 'WAITLISTED' ? 'Waitlisted'
                            : stop.bookingStatus === 'CANCELLED' ? 'Booking cancelled'
                            : 'Not booked yet'}
                        />
                        {/* Marker circle — pale RV-blue/gold palette */}
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                          style={{ background: markerBg, color: markerText }}
                        >
                          {formatStopBadgeMarker(badge)}
                        </div>
                        {/* Bed/Tent type icon — skipped for endpoints. Wrapped
                            in title'd spans so hover explains the glyph. */}
                        {!isEndpoint && (
                          showTent
                            ? <span title="Destination stay (multi-night)" className="flex-shrink-0 flex items-center">
                                <Tent size={14} style={{ color: '#BA7517' }} />
                              </span>
                            : <span title="Overnight stop (one night)" className="flex-shrink-0 flex items-center">
                                <Bed size={14} style={{ color: '#5F5E5A' }} />
                              </span>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-900 truncate">{stop.locationName}</p>
                          {/* FEAT-HAZARD-MAP-PILL — red rig-warning pill + reveal,
                              only on stops carrying recomputed hazard notes. */}
                          <RigWarningPill notes={[
                            ...(hazardsByStop.get(stop.id) ?? []),
                            ...(rigAwareByStop.get(stop.id) === false ? [RV_FALLBACK_DISPLAY_NOTE] : []),
                          ]} />
                          {/* SIDEBAR-READABILITY (2026-09-05, Option A): the drive info was
                              10px light gray and read as disabled. Miles in RV blue,
                              nights as a small chip, and a green / amber per-drive line
                              whose amber wording leads with NOT ("car routing" read as
                              a feature). */}
                          {(() => {
                            const legMiles = (badge !== 'S' && distMiles && prevStop) ? `${distMiles} mi from ${prevStop.locationName}` : null
                            const nightsChip = (badge !== 'S' && badge !== 'H' && badge !== 'F')
                              ? `${stop.nights} night${stop.nights === 1 ? '' : 's'}${stop.type === 'OVERNIGHT_ONLY' ? ' · overnight' : ''}`
                              : null
                            const rigAware = badge !== 'S' ? rigAwareByStop.get(stop.id) : undefined
                            return (
                              <div className="flex flex-col gap-0.5 mt-0.5">
                                {badge === 'S' && <p className="text-xs text-gray-600">Start</p>}
                                {(badge === 'H' || badge === 'F') && <p className="text-xs text-gray-600">Finish</p>}
                                {(legMiles || nightsChip) && (
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {legMiles && <span className="text-xs font-semibold text-[#1F6F8B]">{legMiles}</span>}
                                    {nightsChip && <span className="text-[11px] font-semibold text-gray-700 bg-gray-100 rounded px-1.5 py-px">{nightsChip}</span>}
                                  </div>
                                )}
                                {rigAware === true && (
                                  <p className="text-[11px] font-semibold text-rr-pine-700 flex items-center gap-1"><Check size={11} className="flex-shrink-0 text-rr-pine" /> Planned for your rig</p>
                                )}
                                {rigAware === false && (
                                  <p className="text-[11px] font-semibold text-amber-800 flex items-center gap-1"><AlertTriangle size={11} className="flex-shrink-0 text-amber-600" /> Not planned for your rig</p>
                                )}
                              </div>
                            )
                          })()}
                          {/* RIG-CHANGE Phase 2 — per-stop "booked for" record.
                              Shown for booked stops carrying a stamp. The amber
                              re-verify flag (NOT Pine — Pine is the booked status
                              pill only) appears when the stamped rig is shorter
                              than the current trip rig. */}
                          {BOOKED_STATUSES.includes(stop.bookingStatus) && stop.bookedForRigName && (
                            <>
                              <p className="text-[10px] text-gray-400 truncate">
                                Booked for: {stop.bookedForRigName}{stop.bookedForRigLength != null ? ` (${stop.bookedForRigLength} ft)` : ''}
                              </p>
                              {stop.bookedForRigLength != null && currentRigLength != null && stop.bookedForRigLength < currentRigLength && (
                                <p className="text-[10px] text-amber-700 flex items-center gap-1">
                                  <AlertTriangle size={10} className="flex-shrink-0" /> Re-verify fit for new rig
                                </p>
                              )}
                            </>
                          )}
                          {/* ADDSTOP-RESLOT Phase B — a booked stop whose itinerary
                              date shifted (a later insert moved arrivalDate off the
                              originalBookedDate stamped at booking). Data-derived:
                              persists on reload, clears if the dates realign. The
                              reservation is unchanged — this just flags the date move. */}
                          {BOOKED_STATUSES.includes(stop.bookingStatus) &&
                            stop.originalBookedDate && stop.arrivalDate &&
                            parseTripDate(stop.originalBookedDate)?.getTime() !== parseTripDate(stop.arrivalDate)?.getTime() && (
                              <span className="inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-300" style={{ borderWidth: '0.5px' }}>
                                <AlertTriangle size={11} className="flex-shrink-0" /> Originally booked for {formatTripDate(stop.originalBookedDate, 'MMM d, yyyy')}
                              </span>
                            )}
                          {/* Directions TO this stop (omitted on the FIRST stop —
                              you don't navigate to where you begin). Two origins:
                              current location (origin omitted) or the previous stop
                              (sortedStops[i - 1]). Destination routes to the booked
                              campground when this stop is booked. stopPropagation so
                              a link opens Maps instead of firing the row's focusStop. */}
                          {i > 0 && (
                            <div className="mt-1" onClick={e => e.stopPropagation()}>
                              <NavigateButton
                                hideStatus
                                stop={sortedStops[i]} prevStop={sortedStops[i - 1]}
                                waypoints={hereWaypoints.get(sortedStops[i].id)}
                                rigAware={rigAwareByStop.get(sortedStops[i].id)}
                                tripId={id} source="itinerary" compact label="Navigate"
                              />
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                          {ctaEl}
                          {/* Weather-alert pill — count of distinct active
                              alert types (wind/rain/freeze/snow) in this stop's
                              live forecast. Labeled (never a bare number);
                              "weather" drops out below sm so narrow rows get
                              the compact "N alerts" form. Brand purple tint
                              (tailwind purple = #7F77DD) with a darker shade
                              of the same hue for text; the title lists the
                              specific alert messages as the detail layer. */}
                          {hasAlert && (
                            <span
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-purple/10 text-[#5B53B8]"
                              title={`${alerts.length} weather alert${alerts.length === 1 ? '' : 's'}: ${alerts.map(a => a.message).join(' · ')}`}
                            >
                              <CloudRain size={10} className="flex-shrink-0" />
                              <span className="whitespace-nowrap">
                                {alerts.length}{' '}
                                <span className="hidden sm:inline">weather </span>
                                alert{alerts.length === 1 ? '' : 's'}
                              </span>
                            </span>
                          )}
                          {!stop.isCompatible && (
                            <span title="Potential rig compatibility issue — check this stop's details" className="flex items-center">
                              <AlertTriangle size={11} className="text-red-400" />
                            </span>
                          )}
                        </div>
                        {/* Delete affordance. stopPropagation prevents the
                            row's popup-open click from firing when the user
                            actually wants to remove the stop. Pencil icon
                            (Edit Stop modal trigger) retired — see commit
                            retiring the modal. */}
                        {showDelete && (
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); requestDeleteStop(stop) }}
                              title="Remove stop"
                              className="p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors rounded"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })
                  })()}
                  {/* Total drive footer — replaces the standalone "Miles by segment"
                      panel. Prefers liveTotalMiles (computed locally with Haversine
                      fallback for legs missing driveDistanceMiles) so the value
                      matches the Stats card's totalMiles render at line 1242. Falls
                      back to the persisted trip.totalMiles when the local sum is 0
                      (e.g. before any routes have been computed). */}
                  {(liveTotalMiles > 0 || (trip?.totalMiles ?? 0) > 0) && (
                    <div
                      className="flex items-center justify-between px-2 pt-2 mt-1 border-t border-gray-100 text-xs"
                      style={{ borderTopWidth: '0.5px' }}
                    >
                      <span className="font-medium text-gray-700">Total drive</span>
                      <span className="font-semibold text-gray-900">
                        {(liveTotalMiles > 0 ? liveTotalMiles : (trip?.totalMiles ?? 0)).toLocaleString()} mi
                      </span>
                    </div>
                  )}
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
            flex: 1,
            minWidth: 0,
            height: '100%',
            flexShrink: 0,
            alignSelf: 'flex-start',
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

          {/* FEAT-MAP-TYPE-TOGGLE: Map / Satellite / Terrain segmented control.
              Google's own mapTypeControl stays off (options above) so the map
              keeps RoamReady chrome only. "Satellite" is Google's hybrid mode --
              imagery with labels -- so stops and the route line stay readable.
              Cloud styling (mapId) applies to roadmap only, which is expected. */}
          <div className={`absolute ${isMobile ? 'top-3' : 'top-14'} right-3 z-10 bg-white rounded-lg border border-gray-200 shadow-sm flex overflow-hidden`}>
            {([['roadmap', 'Map'], ['hybrid', 'Satellite'], ['terrain', 'Terrain']] as const).map(([id, label], i) => (
              <button
                key={id}
                onClick={() => setMapTypeId(id)}
                className={`px-2.5 py-1.5 text-xs transition-colors ${i > 0 ? 'border-l border-gray-200' : ''} ${
                  mapTypeId === id ? 'bg-[#1F6F8B] text-white font-semibold' : 'text-gray-600 hover:bg-gray-50'
                }`}
                title={id === 'hybrid' ? 'Satellite imagery with labels' : `${label} view`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* FEAT-TRAFFIC-TOGGLE: overlay button, same chrome as the map-type
              control it sits under (56/12 + control height + 8px gap). */}
          <button
            onClick={() => setTrafficOn(t => !t)}
            className={`absolute ${isMobile ? 'top-[50px]' : 'top-[94px]'} right-3 z-10 rounded-lg border border-gray-200 shadow-sm px-2.5 py-1.5 text-xs transition-colors ${
              trafficOn ? 'bg-[#1F6F8B] text-white font-semibold' : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
            title={trafficOn ? 'Hide live traffic' : 'Show live traffic'}
          >
            Traffic
          </button>

          {isLoaded ? (
            // `center` and `zoom` here are PLACEHOLDER values only — the real
            // framing is applied imperatively by the fitBounds useEffect above,
            // which fires after mapInstance is set and again whenever stops or
            // routePath change. `center` is still memoized so that its reference
            // stays stable: @react-google-maps/api calls map.setCenter whenever the
            // `center` prop reference changes, which would fight the fitBounds-set
            // viewport on every re-render. The memoized reference only changes when
            // the first stop's actual coords change, so it never snaps back on
            // unrelated state updates (popup open/close, layer toggles, etc.).
            // The library has no `defaultCenter` prop, so this is the only option.
            <GoogleMap
              mapContainerStyle={MAP_CONTAINER_STYLE}
              zoom={6}
              center={center}
              mapTypeId={mapTypeId}
              options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false, gestureHandling: 'greedy', mapId: import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID' }}
              onLoad={onMapLoad}
            >
              {/* Driving route. The library's declarative path-prop wasn't
                  propagating setRoutePath changes to the on-map polyline
                  reliably (and a content-derived key didn't fix it either),
                  so we capture the underlying google.maps.Polyline via
                  onLoad and push path updates imperatively from the
                  useEffect on routePath below. No path prop, no key — the
                  component mounts once and the polyline instance lives as
                  long as routePath is truthy; subsequent setRoutePath calls
                  flow through setPath() directly on the captured instance. */}
              {routePath && (
                <Polyline
                  onLoad={pl => {
                    // FIX-GHOST-ROUTE-LINE: StrictMode (and any remount) can hand us a
                    // SECOND polyline instance while the first is still on the map —
                    // remove the old instance or it lingers as a ghost route with a
                    // stale path (visible once the rig-aware and car lines diverge).
                    if (polylineRef.current && polylineRef.current !== pl) {
                      polylineRef.current.setMap(null)
                    }
                    polylineRef.current = pl
                    pl.setPath(routePath)
                  }}
                  onUnmount={() => {
                    // Explicitly detach — the library's own cleanup has proven
                    // unreliable with this imperative-setPath pattern.
                    polylineRef.current?.setMap(null)
                    polylineRef.current = null
                  }}
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

              {/* Custom popup via OverlayView — replaces Google's InfoWindow to avoid
                  the X-shape tail bleed and ghost-popup-on-stop-switch bugs documented
                  in commits 60cc431 → 0552289. The popup, its triangle pointer, and the
                  close button are all rendered as our own React components. No Google
                  chrome involved. */}
              {selectedStop?.latitude && selectedStop?.longitude && (
                <OverlayViewF
                  position={{ lat: selectedStop.latitude, lng: selectedStop.longitude }}
                  mapPaneName="floatPane"
                  getPixelPositionOffset={(width, height) => ({
                    x: -width / 2,
                    y: -height - 36,
                  })}
                  zIndex={1000}
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
                    tripId={id}
                    prevStop={(() => {
                      // Previous stop by order in the full itinerary (omitted on the first).
                      const sorted = trip?.stops?.slice().sort((a, b) => a.order - b.order) ?? []
                      const idx = sorted.findIndex(s => s.id === selectedStop.id)
                      return idx > 0 ? sorted[idx - 1] : undefined
                    })()}
                    waypoints={hereWaypoints.get(selectedStop.id)}
                    rigAware={rigAwareByStop.get(selectedStop.id)}
                  />
                </OverlayViewF>
              )}
            </GoogleMap>
          ) : (
            <div className="h-full flex items-center justify-center bg-gray-100 text-sm text-gray-500">
              Loading map…
            </div>
          )}

          {/* Legend */}
          {isLoaded && trip && <MapLegend combinedSH={combinedSH} />}

          {/* Geocoding indicator */}
          {geocoding && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white border border-gray-200 rounded-full px-4 py-2 text-xs text-gray-600 shadow-md flex items-center gap-2 z-10">
              <span className="w-3 h-3 rounded-full border-2 border-[#1F6F8B] border-t-transparent animate-spin" />
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
              // BUG-MODIFY-GHOST-PATH: a modify apply (e.g. destination change =
              // remove old stop + add new) updates the stops list/totals, but the
              // route polyline is drawn by an effect that DEDUPES on a coords key
              // (directionsCoordsKey). Without invalidating that key, the effect can
              // short-circuit and leave the OLD route line ("ghost path") drawn
              // until a manual reload. Reset the key so the route unconditionally
              // recomputes for the updated stop set on the next effect run (which the
              // setTrip below triggers via the trip.stops dependency).
              directionsCoordsKey.current = null
              setTrip(updatedTrip)
              setTripNameInput(updatedTrip.name)
            }}
          />
        </Suspense>
      )}

      {/* Delete confirmation — opened from sidebar Trash icon */}
      {pendingDeleteStop && (
        <ConfirmModal
          isOpen={true}
          title="Delete this stop?"
          message={buildDeleteConfirmMessage(pendingDeleteStop)}
          confirmLabel="Delete stop"
          cancelLabel="Keep it"
          onConfirm={confirmDeleteStop}
          onCancel={() => { if (!deleting) { setPendingDeleteStop(null); setDeleteError(null) } }}
          danger
          isConfirming={deleting}
        />
      )}

      {/* Long-drive opt-in (Part 2) — trashing an overnight whose removal re-merges
          an over-cap leg. "Keep the long drive" deletes + acknowledges (no re-insert);
          "Cancel" leaves the overnight in place. */}
      {longDrivePrompt && (
        <ConfirmModal
          isOpen={true}
          title={`Remove ${longDrivePrompt.stop.locationName}?`}
          message={
            `Without it, the ${longDrivePrompt.fromName} → ${longDrivePrompt.toName} drive is about ${longDrivePrompt.legHours} hours — over your ${Number.isInteger(longDrivePrompt.cap) ? longDrivePrompt.cap : longDrivePrompt.cap.toFixed(1)}-hour daily limit.` +
            (deleteError ? ` ${deleteError}` : '')
          }
          confirmLabel="Remove it anyway"
          cancelLabel="Keep the stop"
          onConfirm={confirmKeepLongDrive}
          onCancel={() => { if (!deleting) { setLongDrivePrompt(null); setDeleteError(null) } }}
          danger
          isConfirming={deleting}
        />
      )}

      {/* Share trip */}
      {trip && (
        <ShareModal
          trip={trip}
          isOpen={shareOpen}
          onClose={() => setShareOpen(false)}
          onTripUpdated={(sharedToken) =>
            setTrip(prev => prev ? { ...prev, sharedToken: sharedToken ?? undefined } : prev)
          }
        />
      )}

    </div>
  )
}
