import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { tripsApi, journalApi } from '../../services/api'
import AllTripsMap from '../../components/journal/AllTripsMap'
import type { Trip, JournalEntry } from '../../types'

/**
 * Full-page all-trips "memory map" explorer (Step 8) at /journal/map.
 *
 * Thin wrapper around the shared <AllTripsMap> component: this page owns the
 * data fetch, the breadcrumb / back link, the full-height layout, and the
 * loading/error/empty states; AllTripsMap owns all the map rendering (per-trip
 * colors, routes, journal rings, anchored popup, controls). The same component
 * also powers the inline mini-map in the Journal banner.
 */
export default function JournalMapPage() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

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

  return (
    <div className="-mx-4 -my-6">
      {/* Breadcrumb strip — mirrors TripMapPage. First crumb is the back link to
          the RoamReady Journal feed (where "View full map" lives), so this page
          isn't a navigation dead-end. */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100 px-4 py-2 flex items-center gap-1.5">
        <Link
          to="/dashboard?tab=journal"
          className="inline-flex items-center gap-1 text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors"
        >
          <ArrowLeft size={13} /> Journal
        </Link>
        <span className="text-gray-300 text-xs">›</span>
        <span className="text-xs text-gray-700 font-medium">Memory map</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center bg-gray-100 text-sm text-gray-500" style={{ height: 'calc(100vh - 56px)' }}>
          Loading your trips…
        </div>
      ) : error ? (
        <div className="flex items-center justify-center bg-gray-100 text-sm text-gray-500" style={{ height: 'calc(100vh - 56px)' }}>
          Couldn’t load your trips. Please try again.
        </div>
      ) : (
        <AllTripsMap
          trips={trips}
          entries={entries}
          showControls
          className="h-[calc(100vh-56px)]"
        />
      )}
    </div>
  )
}
