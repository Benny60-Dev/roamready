import { lazy, Suspense, useState } from 'react'
import { ChevronDown, Map as MapIcon } from 'lucide-react'

/**
 * Collapsible banner that hosts the visited-states choropleth at the top of the
 * Dashboard Journal view. The heavy map (bundled geometry) is lazy-loaded so it
 * lands in its own chunk and only downloads when the banner is expanded —
 * mirrors the @react-pdf / TripMapPage lazy-load discipline.
 *
 * Collapse preference persists across sessions in localStorage (the app's
 * convention for cross-session prefs, e.g. the zustand-persisted auth store).
 * Default is EXPANDED on first visit (key absent → expanded).
 */
const JournalStatesMap = lazy(() => import('./JournalStatesMap'))

const COLLAPSE_KEY = 'roamready-journal-map-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true'
  } catch {
    return false
  }
}

interface Props {
  overnight: Set<string>
  passthrough: Set<string>
  visitedCount: number
}

export default function VisitedStatesBanner({ overnight, passthrough, visitedCount }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed)

  function toggle() {
    setCollapsed(prev => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSE_KEY, String(next))
      } catch {
        /* storage unavailable (private mode) — pref just won't persist */
      }
      return next
    })
  }

  return (
    <div className="card">
      <button
        onClick={toggle}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-3 text-left"
      >
        <div className="w-8 h-8 bg-[#E0F0F4] rounded-lg flex items-center justify-center flex-shrink-0">
          <MapIcon size={16} className="text-[#1F6F8B]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900">States visited</p>
          <p className="text-xs text-gray-500">
            {visitedCount} of 50 states · tap to {collapsed ? 'show' : 'hide'} the map
          </p>
        </div>
        <ChevronDown
          size={18}
          className={`text-gray-400 transition-transform flex-shrink-0 ${collapsed ? '' : 'rotate-180'}`}
        />
      </button>

      {!collapsed && (
        <div className="mt-4 pt-4 border-t border-gray-100">
          <Suspense
            fallback={<div className="h-48 rounded-lg bg-gray-50 animate-pulse" aria-hidden="true" />}
          >
            <JournalStatesMap
              overnight={overnight}
              passthrough={passthrough}
              visitedCount={visitedCount}
            />
          </Suspense>
        </div>
      )}
    </div>
  )
}
