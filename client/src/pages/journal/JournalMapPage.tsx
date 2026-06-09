import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api'
import { tripsApi, journalApi } from '../../services/api'
import { parseTripDate } from '../../utils/dates'
import { deriveTripStatus } from '../../utils/tripStatus'
import type { Trip, Stop, JournalEntry } from '../../types'

/**
 * All-trips "memory map" explorer (Step 8).
 *
 * Phase A — scaffold: render every stop across every trip and frame with
 * fitBounds. Phase B (this): per-trip colors + straight-line routes. Gold
 * journal rings and trip-filter chips are Phases C/D.
 *
 * Map plumbing here is a deliberate COPY of the single-trip TripMapPage engine
 * (loader config, GoogleMap options, the AdvancedMarkerElement/markersRef
 * imperative-marker pattern). TripMapPage is intentionally left untouched —
 * we do not extract or share its internals.
 */

// ── Map config (copied from TripMapPage) ──────────────────────────────────────
const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' }
const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

// ── Per-trip palette (Phase B) ────────────────────────────────────────────────
// The active/primary trip is RV Blue; every other trip cycles the ramp below in
// a stable order. Pine #3E5540 is deliberately ABSENT — it stays reserved.
const ACTIVE_COLOR = '#1F6F8B' // RV Blue
const PALETTE = ['#7F77DD', '#D85A30', '#1D9E75', '#D4537E'] // purple, coral, teal, pink

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
 *  Copied/simplified from TripMapPage.makeMarkerContent — a plain colored dot,
 *  no badge text (badges are intentionally dropped on this view). */
function makeMarkerContent(color: string, isJournaled: boolean): HTMLElement {
  const div = document.createElement('div')
  div.style.cssText = `width:18px;height:18px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:pointer`
  // Forward-compat for Phase C: flag journaled stops on the element now so the
  // gold-ring pass can find them. No visual treatment yet.
  div.dataset.journaled = String(isJournaled)
  return div
}

interface StopWithTrip extends Stop {
  tripName: string
  color: string
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

  // Set of stopIds that have a journal entry — built client-side from the
  // already-loaded feed. Phase C will ring these stops in gold; for now the set
  // only tags markers via dataset (no visual ring yet).
  const journaledStopIds = useMemo(() => {
    const s = new Set<string>()
    for (const e of entries) if (e.stopId) s.add(e.stopId)
    return s
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

  // ── Imperative markers (copied pattern from TripMapPage) ─────────────────────
  useEffect(() => {
    markersRef.current.forEach(m => { m.map = null })
    markersRef.current = []

    if (!mapInstance || !stopsWithCoords.length) return

    stopsWithCoords.forEach(stop => {
      const marker = new window.google.maps.marker.AdvancedMarkerElement({
        position: { lat: stop.latitude!, lng: stop.longitude! },
        map: mapInstance,
        content: makeMarkerContent(stop.color, journaledStopIds.has(stop.id)),
        title: `${stop.locationName} · ${stop.tripName}`,
      })
      markersRef.current.push(marker)
    })
  }, [mapInstance, stopsWithCoords, journaledStopIds])

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
            />
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
