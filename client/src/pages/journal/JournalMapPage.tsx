import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { GoogleMap, useJsApiLoader, OverlayViewF } from '@react-google-maps/api'
import { X, BookOpen } from 'lucide-react'
import { tripsApi, journalApi } from '../../services/api'
import { parseTripDate } from '../../utils/dates'
import { deriveTripStatus } from '../../utils/tripStatus'
import type { Trip, Stop, JournalEntry } from '../../types'

/**
 * All-trips "memory map" explorer (Step 8).
 *
 * Phase A — scaffold: render every stop and frame with fitBounds. Phase B:
 * per-trip colors + straight-line routes. Phase C (this): gold journal rings on
 * journaled stops + a tap-for-details popup. Trip-filter chips are Phase D.
 *
 * Map plumbing here is a deliberate COPY of the single-trip TripMapPage engine
 * (loader config, GoogleMap options, the AdvancedMarkerElement/markersRef
 * imperative-marker pattern, the OverlayViewF popup). TripMapPage is
 * intentionally left untouched — we do not extract or share its internals.
 */

// ── Map config (copied from TripMapPage) ──────────────────────────────────────
const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' }
const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

// ── Per-trip palette (Phase B) ────────────────────────────────────────────────
// The active/primary trip is RV Blue; every other trip cycles the ramp below in
// a stable order. Pine #3E5540 is deliberately ABSENT — it stays reserved.
const ACTIVE_COLOR = '#1F6F8B' // RV Blue
const PALETTE = ['#7F77DD', '#D85A30', '#1D9E75', '#D4537E'] // purple, coral, teal, pink
const JOURNAL_RING = '#F7A829' // gold — outline on stops with a journal entry

/** Effective sort key (ms) for stable color ordering: the trip's start date,
 *  falling back to its first dated stop, then its creation time. */
function tripSortKey(t: Trip): number {
  const start =
    parseTripDate(t.startDate) ??
    parseTripDate((t.stops ?? []).find(s => s.arrivalDate != null)?.arrivalDate) ??
    parseTripDate(t.createdAt)
  return start ? start.getTime() : 0
}

/** Creates the HTML element used as an AdvancedMarkerElement's content.
 *  Copied/simplified from TripMapPage.makeMarkerContent — a plain per-trip
 *  colored dot (no badge text). Journaled stops get a gold OUTLINE ring (Phase
 *  C): the dot keeps its trip color inside, a 3px white border separates it
 *  from a gold spread-shadow ring — so the ring reads on every trip color. */
function makeMarkerContent(color: string, isJournaled: boolean): HTMLElement {
  const div = document.createElement('div')
  // Gold ring = a hard (no-blur) 2px spread box-shadow OUTSIDE the white
  // border, layered before the usual drop shadow.
  const ring = isJournaled ? `0 0 0 2px ${JOURNAL_RING}, ` : ''
  div.style.cssText = `width:18px;height:18px;border-radius:50%;background:${color};border:3px solid white;box-shadow:${ring}0 2px 6px rgba(0,0,0,0.3);cursor:pointer`
  div.dataset.journaled = String(isJournaled)
  return div
}

interface StopWithTrip extends Stop {
  tripName: string
  color: string
}

/** Trimmed copy of TripMapPage's StopPopup — name, which trip, and the linked
 *  journal entry's title + snippet if one exists. No weather / booking / nights
 *  controls. Rendered via OverlayViewF, same as TripMapPage. */
function JournalStopPopup({
  stop, entry, onClose,
}: {
  stop: StopWithTrip
  entry: JournalEntry | undefined
  onClose: () => void
}) {
  const snippet = entry?.body ? entry.body.trim().slice(0, 140) : ''
  return (
    <div className="flex flex-col items-center">
      <div className="bg-white rounded-xl shadow-xl p-4 w-72">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: stop.color }}
            />
            <span className="text-[10px] font-medium text-gray-500 truncate">{stop.tripName}</span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded flex-shrink-0"><X size={14} /></button>
        </div>

        <p className="font-semibold text-sm text-gray-900 leading-snug">
          {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
        </p>

        {entry ? (
          <div className="mt-2 pt-2 border-t border-gray-100">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#C9851A] uppercase tracking-wide mb-1">
              <BookOpen size={11} /> Journal entry
            </div>
            {entry.title && (
              <p className="text-xs font-medium text-gray-800 leading-snug">{entry.title}</p>
            )}
            {snippet && (
              <p className="text-xs text-gray-500 mt-0.5 leading-snug">
                {snippet}{entry.body && entry.body.trim().length > 140 ? '…' : ''}
              </p>
            )}
            {stop.tripId && (
              <Link
                to={`/trips/${stop.tripId}/journal`}
                className="inline-block text-xs font-medium text-[#1F6F8B] hover:underline mt-1.5"
              >
                View in journal ›
              </Link>
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-400 mt-1">No journal entry for this stop yet.</p>
        )}
      </div>
    </div>
  )
}

interface TripRoute {
  tripId: string
  color: string
  path: google.maps.LatLngLiteral[]
}

export default function JournalMapPage() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null)
  const [selectedStop, setSelectedStop] = useState<StopWithTrip | null>(null)
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([])
  const polylinesRef = useRef<google.maps.Polyline[]>([])

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES,
  })

  // ── Data: all trips (with stops + coords) and all journal entries ────────────
  // tripsApi.getAll() is the same single call the Dashboard uses — every trip
  // with its ordered stops and coords in one request. journalApi.list() mirrors
  // JournalTabContent's feed fetch.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    Promise.all([tripsApi.getAll(), journalApi.list()])
      .then(([tripsRes, entriesRes]) => {
        if (cancelled) return
        setTrips(tripsRes.data)
        setEntries(entriesRes.data)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setError(true)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // First journal entry per stop, keyed by stopId — drives both the gold ring
  // (presence) and the popup (title/snippet). Built from the already-loaded
  // feed; no new fetch.
  const entryByStop = useMemo(() => {
    const m = new Map<string, JournalEntry>()
    for (const e of entries) if (e.stopId && !m.has(e.stopId)) m.set(e.stopId, e)
    return m
  }, [entries])

  // Stable trip → color map (Phase B). The active trip (or, if none is active,
  // the most recent one) gets RV Blue; the rest cycle the palette in a stable
  // date order so a given trip keeps its color across renders. More trips than
  // palette entries simply wrap.
  const colorByTrip = useMemo(() => {
    const map = new Map<string, string>()
    if (trips.length === 0) return map

    // Stable ordering first — drives both the primary pick (most-recent
    // fallback) and the palette cycling.
    const ordered = [...trips].sort((a, b) => tripSortKey(a) - tripSortKey(b))

    // Primary = first ACTIVE trip (latest if several), else the most recent.
    const active = ordered.filter(t => deriveTripStatus(t) === 'ACTIVE')
    const primary = active.length
      ? active[active.length - 1]
      : ordered[ordered.length - 1]

    map.set(primary.id, ACTIVE_COLOR)
    let i = 0
    for (const t of ordered) {
      if (t.id === primary.id) continue
      map.set(t.id, PALETTE[i % PALETTE.length])
      i++
    }
    return map
  }, [trips])

  // Flatten every trip's stops that actually have coords. Skip null lat/lng.
  const stopsWithCoords = useMemo<StopWithTrip[]>(() => {
    const out: StopWithTrip[] = []
    for (const t of trips) {
      const color = colorByTrip.get(t.id) ?? ACTIVE_COLOR
      for (const stop of t.stops ?? []) {
        if (stop.latitude == null || stop.longitude == null) continue
        out.push({ ...stop, tripName: t.name, color })
      }
    }
    return out
  }, [trips, colorByTrip])

  // Straight-line route per trip: stops in order (asc), coord-bearing only, no
  // Routes/Directions API. A trip needs ≥2 coord stops to draw a segment.
  const routes = useMemo<TripRoute[]>(() => {
    const out: TripRoute[] = []
    for (const t of trips) {
      const path = [...(t.stops ?? [])]
        .sort((a, b) => a.order - b.order)
        .filter(s => s.latitude != null && s.longitude != null)
        .map(s => ({ lat: s.latitude!, lng: s.longitude! }))
      if (path.length < 2) continue
      out.push({ tripId: t.id, color: colorByTrip.get(t.id) ?? ACTIVE_COLOR, path })
    }
    return out
  }, [trips, colorByTrip])

  const onMapLoad = useCallback((map: google.maps.Map) => {
    setMapInstance(map)
  }, [])

  // Open a stop's popup and bring it into view. Simplified from TripMapPage's
  // focusStop: pan to the stop, then nudge the camera up a touch so the popup
  // card (which anchors above the marker) has room.
  const focusStop = useCallback((stop: StopWithTrip) => {
    setSelectedStop(stop)
    if (mapInstance && stop.latitude != null && stop.longitude != null) {
      mapInstance.panTo({ lat: stop.latitude, lng: stop.longitude })
      mapInstance.panBy(0, -120)
    }
  }, [mapInstance])

  // ── Imperative markers (copied pattern from TripMapPage) ─────────────────────
  useEffect(() => {
    markersRef.current.forEach(m => { m.map = null })
    markersRef.current = []

    if (!mapInstance || !stopsWithCoords.length) return

    stopsWithCoords.forEach(stop => {
      const marker = new window.google.maps.marker.AdvancedMarkerElement({
        position: { lat: stop.latitude!, lng: stop.longitude! },
        map: mapInstance,
        content: makeMarkerContent(stop.color, entryByStop.has(stop.id)),
        title: `${stop.locationName} · ${stop.tripName}`,
      })
      marker.addListener('click', () => focusStop(stop))
      markersRef.current.push(marker)
    })
  }, [mapInstance, stopsWithCoords, entryByStop, focusStop])

  // ── Straight-line route polylines, one per trip (Phase B) ────────────────────
  // Imperative, mirroring the markersRef discipline: clear the old set, then
  // draw a colored Polyline through each trip's ordered stops.
  useEffect(() => {
    polylinesRef.current.forEach(p => p.setMap(null))
    polylinesRef.current = []

    if (!mapInstance || !routes.length) return

    routes.forEach(route => {
      const polyline = new window.google.maps.Polyline({
        path: route.path,
        map: mapInstance,
        strokeColor: route.color,
        strokeWeight: 2.5,
        strokeOpacity: 0.85,
      })
      polylinesRef.current.push(polyline)
    })
  }, [mapInstance, routes])

  // Cleanup markers + polylines on unmount.
  useEffect(() => () => {
    markersRef.current.forEach(m => { m.map = null })
    polylinesRef.current.forEach(p => p.setMap(null))
  }, [])

  // ── fitBounds over every visible stop (copied pattern from TripMapPage) ──────
  useEffect(() => {
    if (!mapInstance || stopsWithCoords.length === 0) return

    // A single stop yields a zero-size bounds that fitBounds would blow up to
    // max zoom — center on it at a sane fixed zoom instead.
    if (stopsWithCoords.length < 2) {
      const s = stopsWithCoords[0]
      mapInstance.setCenter({ lat: s.latitude!, lng: s.longitude! })
      mapInstance.setZoom(10)
      return
    }

    const bounds = new window.google.maps.LatLngBounds()
    for (const s of stopsWithCoords) bounds.extend({ lat: s.latitude!, lng: s.longitude! })

    // All coords identical → same degenerate case.
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      mapInstance.setCenter(bounds.getCenter())
      mapInstance.setZoom(10)
      return
    }

    mapInstance.fitBounds(bounds, { top: 72, right: 60, bottom: 60, left: 60 })
  }, [mapInstance, stopsWithCoords])

  const hasStops = stopsWithCoords.length > 0

  // Minimal color key — only trips that actually have a pin on the map, in the
  // same stable order the palette was assigned. Phase D's filter chips will
  // supersede this; for now it just helps read the colors.
  const legend = useMemo(() => {
    const seen = new Set<string>()
    const rows: Array<{ id: string, name: string, color: string }> = []
    const visibleTripIds = new Set(stopsWithCoords.map(s => s.tripId))
    for (const t of [...trips].sort((a, b) => tripSortKey(a) - tripSortKey(b))) {
      if (!visibleTripIds.has(t.id) || seen.has(t.id)) continue
      seen.add(t.id)
      rows.push({ id: t.id, name: t.name, color: colorByTrip.get(t.id) ?? ACTIVE_COLOR })
    }
    return rows
  }, [trips, stopsWithCoords, colorByTrip])

  return (
    <div className="-mx-4 -my-6">
      {/* Breadcrumb strip — mirrors TripMapPage */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100 px-4 py-2 flex items-center gap-1.5">
        <Link to="/dashboard" className="text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors">Dashboard</Link>
        <span className="text-gray-300 text-xs">›</span>
        <span className="text-xs text-gray-700 font-medium">Memory map</span>
      </div>

      <div className="relative" style={{ height: 'calc(100vh - 120px)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center bg-gray-100 text-sm text-gray-500">
            Loading your trips…
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center bg-gray-100 text-sm text-gray-500">
            Couldn’t load your trips. Please try again.
          </div>
        ) : !hasStops ? (
          <div className="h-full flex flex-col items-center justify-center bg-gray-100 text-center px-6">
            <p className="text-sm font-medium text-gray-700">No mapped stops yet</p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs">
              Once your trips have stops with locations, they’ll show up here on your memory map.
            </p>
          </div>
        ) : isLoaded ? (
          <>
            <GoogleMap
              mapContainerStyle={MAP_CONTAINER_STYLE}
              zoom={4}
              center={{ lat: 39.5, lng: -98.35 }}
              options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false, gestureHandling: 'greedy', mapId: import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID' }}
              onLoad={onMapLoad}
              onClick={() => setSelectedStop(null)}
            >
              {/* Tap-a-stop details popup — same OverlayViewF pattern as
                  TripMapPage (copied), trimmed to name + trip + journal entry. */}
              {selectedStop?.latitude != null && selectedStop?.longitude != null && (
                <OverlayViewF
                  position={{ lat: selectedStop.latitude, lng: selectedStop.longitude }}
                  mapPaneName="floatPane"
                  getPixelPositionOffset={(width, height) => ({ x: -width / 2, y: -height - 36 })}
                  zIndex={1000}
                >
                  <JournalStopPopup
                    stop={selectedStop}
                    entry={entryByStop.get(selectedStop.id)}
                    onClose={() => setSelectedStop(null)}
                  />
                </OverlayViewF>
              )}
            </GoogleMap>
            {/* Minimal color key (Phase D chips will supersede this). */}
            {legend.length > 0 && (
              <div className="absolute bottom-6 left-4 bg-white rounded-xl border border-gray-200 px-3 py-2.5 shadow-md z-10 max-w-[220px]" style={{ borderWidth: '0.5px' }}>
                <div className="space-y-1.5">
                  {legend.map(row => (
                    <div key={row.id} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: row.color }} />
                      <span className="text-xs text-gray-700 truncate">{row.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="h-full flex items-center justify-center bg-gray-100 text-sm text-gray-500">
            Loading map…
          </div>
        )}
      </div>
    </div>
  )
}
