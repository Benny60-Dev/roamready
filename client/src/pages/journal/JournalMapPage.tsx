import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { GoogleMap, useJsApiLoader, OverlayViewF } from '@react-google-maps/api'
import { X, BookOpen, Spline } from 'lucide-react'
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

// THE LINCHPIN: a STABLE center reference. @react-google-maps/api re-applies
// map.setCenter whenever the `center` prop's reference changes — and an inline
// object literal is a new reference on every render, so it would snap the map
// back to this US-center point on EVERY re-render (including the one triggered
// by selecting a stop), fighting panTo/fitBounds and causing the "tap a stop →
// map flies to mid-US" jump. Hoisting it to a module constant keeps the ref
// stable: setCenter fires once on mount and never again, so user zoom/pan,
// fitBounds, and focusStop's panTo all stick. (TripMapPage memoizes its center
// for the same reason — see its center useMemo.)
const DEFAULT_CENTER = { lat: 39.5, lng: -98.35 }

// "Show routes" preference persists across sessions, mirroring the banner's
// pin/collapse prefs. Default ON — only an explicit 'false' hides the lines.
const ROUTES_KEY = 'roamready-journal-map-routes'
function readShowRoutes(): boolean {
  try {
    return localStorage.getItem(ROUTES_KEY) !== 'false'
  } catch {
    return true
  }
}

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
 *  Copied/adapted from TripMapPage.makeMarkerContent — a per-trip colored dot
 *  (no badge text). Journaled stops (Phase C) get a BOLD gold treatment: a
 *  solid gold #F7A829 disc with the trip color as a smaller core, separated by
 *  a thin white ring so the core reads on every trip color. The gold is
 *  visually dominant so a journaled stop is obvious at a glance while still
 *  showing which trip it belongs to. Plain stops keep the colored dot + white
 *  border. */
function makeMarkerContent(color: string, isJournaled: boolean): HTMLElement {
  const div = document.createElement('div')
  if (isJournaled) {
    // Layered box-shadows on a small colored core: 1.5px white separator, then
    // a bold 6px solid gold ring (the "disc"), then the drop shadow. Total
    // ~27px — bigger than a plain dot, reinforcing the at-a-glance read.
    div.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};box-shadow:0 0 0 1.5px #fff, 0 0 0 7.5px ${JOURNAL_RING}, 0 2px 6px rgba(0,0,0,0.35);cursor:pointer`
  } else {
    div.style.cssText = `width:18px;height:18px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:pointer`
  }
  div.dataset.journaled = String(isJournaled)
  return div
}

interface StopWithTrip extends Stop {
  tripName: string
  color: string
}

/** Trimmed copy of TripMapPage's StopPopup — name, which trip, and the linked
 *  journal entry's title + snippet if one exists. No weather / booking / nights
 *  controls. Rendered via OverlayViewF anchored to the marker (fixed w-72 so the
 *  anchor math is stable), with a downward triangle pointer at the marker —
 *  identical anchoring on every viewport. */
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
      {/* Triangle pointer — sibling of the card, pointing down at the marker.
          marginTop:-1px overlaps the card's bottom edge by 1px to hide the seam.
          Copied from TripMapPage's StopPopup. */}
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
  // Trip-filter (Phase D): null = "All trips"; otherwise isolate one trip.
  const [filterTripId, setFilterTripId] = useState<string | null>(null)
  // "Show routes" toggle — hide the connecting lines for a pins-only view.
  const [showRoutes, setShowRoutes] = useState(readShowRoutes)
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

  // Trip-filter applied (Phase D): "All trips" (filterTripId null) shows
  // everything; otherwise only the selected trip's stops + route. Markers,
  // polylines, and fitBounds all key off these so isolating a trip hides the
  // rest AND reframes to fit just it.
  const visibleStops = useMemo(
    () => (filterTripId ? stopsWithCoords.filter(s => s.tripId === filterTripId) : stopsWithCoords),
    [stopsWithCoords, filterTripId],
  )
  const visibleRoutes = useMemo(
    () => (filterTripId ? routes.filter(r => r.tripId === filterTripId) : routes),
    [routes, filterTripId],
  )

  const onMapLoad = useCallback((map: google.maps.Map) => {
    setMapInstance(map)
  }, [])

  // Persist the routes-visibility preference across sessions.
  const toggleRoutes = useCallback(() => {
    setShowRoutes(prev => {
      const next = !prev
      try {
        localStorage.setItem(ROUTES_KEY, String(next))
      } catch {
        /* storage unavailable (private mode) — pref just won't persist */
      }
      return next
    })
  }, [])

  // Open a stop's popup AND pan so the marker + its anchored card are both
  // visible. Copied from TripMapPage.focusStop. Safe now that DEFAULT_CENTER is
  // a stable ref — without that, the re-render from setSelectedStop would re-fire
  // setCenter to US-center and override this panTo (the old jump bug).
  const focusStop = useCallback((stop: StopWithTrip) => {
    setSelectedStop(stop)
    if (mapInstance && stop.latitude != null && stop.longitude != null) {
      mapInstance.panTo({ lat: stop.latitude, lng: stop.longitude })
      // Clearance for the trimmed journal card (shorter than TripMapPage's full
      // card): ~220px card + 36px marker-to-triangle gap + 24px breathing room.
      const NEEDED_CLEARANCE_PX = 220 + 36 + 24  // = 280
      const mapH = mapInstance.getDiv()?.clientHeight ?? 550
      // Marker's final screen-y after panBy = mapH/2 + offset, so
      // offset >= NEEDED_CLEARANCE_PX - mapH/2 puts the card's top at the
      // viewport top (breathing room baked in). 80px floor; cap at 30% below
      // center so the marker stays visible on short maps.
      const idealOffset = Math.max(NEEDED_CLEARANCE_PX - mapH / 2, 80)
      const capOffset = mapH * 0.3
      const offset = Math.min(idealOffset, capOffset)
      // panBy(0, NEGATIVE) moves the map CENTER up → marker appears LOWER on
      // screen, leaving room above for the upward-opening card.
      mapInstance.panBy(0, -offset)
    }
  }, [mapInstance])

  // ── Imperative markers (copied pattern from TripMapPage) ─────────────────────
  useEffect(() => {
    markersRef.current.forEach(m => { m.map = null })
    markersRef.current = []

    if (!mapInstance || !visibleStops.length) return

    visibleStops.forEach(stop => {
      const marker = new window.google.maps.marker.AdvancedMarkerElement({
        position: { lat: stop.latitude!, lng: stop.longitude! },
        map: mapInstance,
        content: makeMarkerContent(stop.color, entryByStop.has(stop.id)),
        title: `${stop.locationName} · ${stop.tripName}`,
      })
      marker.addListener('click', () => focusStop(stop))
      markersRef.current.push(marker)
    })
  }, [mapInstance, visibleStops, entryByStop, focusStop])

  // ── Straight-line route polylines, one per trip (Phase B) ────────────────────
  // Imperative, mirroring the markersRef discipline: clear the old set, then
  // draw a colored Polyline through each trip's ordered stops.
  useEffect(() => {
    polylinesRef.current.forEach(p => p.setMap(null))
    polylinesRef.current = []

    // Routes off → clear (done above) and draw nothing, for a pins-only view.
    // Markers, rings, popups, and filter chips are unaffected.
    if (!mapInstance || !showRoutes || !visibleRoutes.length) return

    visibleRoutes.forEach(route => {
      const polyline = new window.google.maps.Polyline({
        path: route.path,
        map: mapInstance,
        strokeColor: route.color,
        strokeWeight: 2.5,
        strokeOpacity: 0.85,
      })
      polylinesRef.current.push(polyline)
    })
  }, [mapInstance, visibleRoutes, showRoutes])

  // Cleanup markers + polylines on unmount.
  useEffect(() => () => {
    markersRef.current.forEach(m => { m.map = null })
    polylinesRef.current.forEach(p => p.setMap(null))
  }, [])

  // ── fitBounds over the VISIBLE stops (copied pattern from TripMapPage) ───────
  // Re-runs on filter change: isolating a trip reframes to fit just it; "All
  // trips" fits everything. Operates imperatively after mount, so it doesn't
  // touch the stable DEFAULT_CENTER prop.
  useEffect(() => {
    if (!mapInstance || visibleStops.length === 0) return

    // A single stop yields a zero-size bounds that fitBounds would blow up to
    // max zoom — center on it at a sane fixed zoom instead.
    if (visibleStops.length < 2) {
      const s = visibleStops[0]
      mapInstance.setCenter({ lat: s.latitude!, lng: s.longitude! })
      mapInstance.setZoom(10)
      return
    }

    const bounds = new window.google.maps.LatLngBounds()
    for (const s of visibleStops) bounds.extend({ lat: s.latitude!, lng: s.longitude! })

    // All coords identical → same degenerate case.
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      mapInstance.setCenter(bounds.getCenter())
      mapInstance.setZoom(10)
      return
    }

    mapInstance.fitBounds(bounds, { top: 72, right: 60, bottom: 60, left: 60 })
  }, [mapInstance, visibleStops])

  const hasStops = stopsWithCoords.length > 0

  // Trip-filter chips — one per trip that has a pin on the map, in the same
  // stable order the palette was assigned, each carrying its route color. The
  // chips replace the Phase B corner legend (trip identity + color live here).
  const tripChips = useMemo(() => {
    const seen = new Set<string>()
    const rows: Array<{ id: string, name: string, color: string }> = []
    const tripIdsWithPins = new Set(stopsWithCoords.map(s => s.tripId))
    for (const t of [...trips].sort((a, b) => tripSortKey(a) - tripSortKey(b))) {
      if (!tripIdsWithPins.has(t.id) || seen.has(t.id)) continue
      seen.add(t.id)
      rows.push({ id: t.id, name: t.name, color: colorByTrip.get(t.id) ?? ACTIVE_COLOR })
    }
    return rows
  }, [trips, stopsWithCoords, colorByTrip])

  // If the isolated trip disappears (data reload), fall back to "All trips".
  useEffect(() => {
    if (filterTripId && !tripChips.some(c => c.id === filterTripId)) setFilterTripId(null)
  }, [filterTripId, tripChips])

  return (
    <div className="-mx-4 -my-6">
      {/* Breadcrumb strip — mirrors TripMapPage */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100 px-4 py-2 flex items-center gap-1.5">
        <Link to="/dashboard" className="text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors">Dashboard</Link>
        <span className="text-gray-300 text-xs">›</span>
        <span className="text-xs text-gray-700 font-medium">Memory map</span>
      </div>

      {/* Trip-filter chips (Phase D) + "Show routes" toggle. The chips scroll
          horizontally on narrow screens; the toggle stays pinned on the right.
          Chip/toggle styling mirrors the Journal feed's filter chips. */}
      {!loading && !error && hasStops && (
        <div className="flex-shrink-0 bg-white border-b border-gray-100 px-4 py-2 flex items-center gap-2">
          <div className="flex gap-1.5 overflow-x-auto flex-1" role="tablist" aria-label="Trip filters">
            <button
              role="tab"
              aria-selected={filterTripId === null}
              onClick={() => setFilterTripId(null)}
              className={`flex-shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filterTripId === null
                  ? 'bg-[#1F6F8B] text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
              style={{ borderWidth: '0.5px' }}
            >
              All trips
            </button>
            {tripChips.map(chip => {
              const active = filterTripId === chip.id
              return (
                <button
                  key={chip.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilterTripId(chip.id)}
                  className={`flex-shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    active
                      ? 'bg-[#1F6F8B] text-white'
                      : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                  style={{ borderWidth: '0.5px' }}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-black/5"
                    style={{ backgroundColor: chip.color }}
                  />
                  {chip.name}
                </button>
              )
            })}
          </div>

          {/* Routes-visibility toggle — pinned right, doesn't scroll with chips. */}
          <button
            onClick={toggleRoutes}
            aria-pressed={showRoutes}
            className={`flex-shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              showRoutes
                ? 'bg-[#1F6F8B] text-white'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
            style={{ borderWidth: '0.5px' }}
          >
            <Spline size={12} /> Show routes
          </button>
        </div>
      )}

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
              center={DEFAULT_CENTER}
              options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false, gestureHandling: 'greedy', mapId: import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID' }}
              onLoad={onMapLoad}
              onClick={() => setSelectedStop(null)}
            >
              {/* Marker-anchored popup — same OverlayViewF pattern as
                  TripMapPage (copied verbatim), identical on every viewport.
                  position tracks the stop's geographic point so the card + its
                  triangle pointer stay glued to the right marker as the map
                  pans; getPixelPositionOffset centers the card over the marker
                  and lifts it (height + 36px) so the pointer tip sits just above
                  the marker. */}
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
