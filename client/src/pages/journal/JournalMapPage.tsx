import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api'
import { tripsApi, journalApi } from '../../services/api'
import type { Trip, Stop, JournalEntry } from '../../types'

/**
 * All-trips "memory map" explorer (Step 8).
 *
 * Phase A — SCAFFOLD ONLY: render every stop across every trip as a plain
 * neutral marker and frame them all with fitBounds. Per-trip colors, straight-
 * line routes, gold journal rings, and trip-filter chips are Phases B/C/D.
 *
 * Map plumbing here is a deliberate COPY of the single-trip TripMapPage engine
 * (loader config, GoogleMap options, the AdvancedMarkerElement/markersRef
 * imperative-marker pattern). TripMapPage is intentionally left untouched —
 * we do not extract or share its internals.
 */

// ── Map config (copied from TripMapPage) ──────────────────────────────────────
const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' }
const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

// Phase A neutral marker color. Per-trip colors arrive in Phase B.
const NEUTRAL_MARKER = '#888780' // gray

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
}

export default function JournalMapPage() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null)
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([])

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

  // Flatten every trip's stops that actually have coords. Skip null lat/lng.
  const stopsWithCoords = useMemo<StopWithTrip[]>(() => {
    const out: StopWithTrip[] = []
    for (const t of trips) {
      for (const stop of t.stops ?? []) {
        if (stop.latitude == null || stop.longitude == null) continue
        out.push({ ...stop, tripName: t.name })
      }
    }
    return out
  }, [trips])

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
        content: makeMarkerContent(NEUTRAL_MARKER, journaledStopIds.has(stop.id)),
        title: `${stop.locationName} · ${stop.tripName}`,
      })
      markersRef.current.push(marker)
    })
  }, [mapInstance, stopsWithCoords, journaledStopIds])

  // Cleanup markers on unmount.
  useEffect(() => () => { markersRef.current.forEach(m => { m.map = null }) }, [])

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
          <GoogleMap
            mapContainerStyle={MAP_CONTAINER_STYLE}
            zoom={4}
            center={{ lat: 39.5, lng: -98.35 }}
            options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false, gestureHandling: 'greedy', mapId: import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID' }}
            onLoad={onMapLoad}
          />
        ) : (
          <div className="h-full flex items-center justify-center bg-gray-100 text-sm text-gray-500">
            Loading map…
          </div>
        )}
      </div>
    </div>
  )
}
