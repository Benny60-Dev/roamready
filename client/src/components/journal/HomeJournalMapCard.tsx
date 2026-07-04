import { lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import { MapPin, ChevronRight } from 'lucide-react'
import type { Trip } from '../../types'
import { useVisitedStates } from './visitedStates'

// Same lazy split VisitedStatesBanner uses — the bundled AlbersUSA geometry
// lands in its own chunk and only downloads when this card actually renders
// (empty-state Home only). States-only: no Google Maps bundle here.
const JournalStatesMap = lazy(() => import('./JournalStatesMap'))

/**
 * Home-page discovery card for the Journal Maps feature. The states choropleth
 * is otherwise buried in a Dashboard tab most users never open; surfacing a
 * teaser here (under the "Continue planning" strip) advertises it and links into
 * the full experience. Reuses the exact Dashboard derivation via useVisitedStates
 * so the counts always agree.
 */
export default function HomeJournalMapCard({ trips }: { trips: Trip[] }) {
  const { overnight, passthrough, visitedCount, loading } = useVisitedStates(trips)

  // Hold space with a light skeleton while entries/manual marks load (trips are
  // already in hand from the parent) so the card doesn't pop in mid-scroll.
  if (loading) {
    return (
      <div className="card">
        <div className="h-6 w-44 rounded bg-gray-50 animate-pulse" />
      </div>
    )
  }

  // Empty state — no states visited yet (new user, or no completed trips).
  if (visitedCount === 0) {
    return (
      <div className="card">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[#E0F0F4] rounded-lg flex items-center justify-center flex-shrink-0">
            <MapPin size={16} className="text-[#1F6F8B]" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">Your travel map</p>
            <p className="text-xs text-gray-500">
              No states traveled yet — your map fills in automatically as you take trips.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Populated — states choropleth teaser + deep link into the Dashboard Journal
  // Maps tab (the full States/Trips experience with editing lives there).
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-[#E0F0F4] rounded-lg flex items-center justify-center flex-shrink-0">
            <MapPin size={16} className="text-[#1F6F8B]" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">Your travel map</p>
            <p className="text-xs text-gray-500">The states you've camped in — tap any state for details.</p>
          </div>
        </div>
        <Link
          to="/dashboard?tab=journal"
          className="text-xs text-[#1F6F8B] hover:underline flex items-center gap-1 flex-shrink-0"
        >
          Open your journal maps
          <ChevronRight size={12} />
        </Link>
      </div>
      <div className="max-w-md mx-auto">
        <Suspense fallback={<div className="h-48 rounded-lg bg-gray-50 animate-pulse" aria-hidden="true" />}>
          <JournalStatesMap overnight={overnight} passthrough={passthrough} visitedCount={visitedCount} />
        </Suspense>
      </div>
    </div>
  )
}
