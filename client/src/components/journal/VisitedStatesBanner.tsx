import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, Map as MapIcon, Pencil, MapPin, Globe } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { useUIStore } from '../../store/uiStore'
import EditStatesModal from './EditStatesModal'
import type { StateMeta } from './stateUtils'
import type { JournalEntry, Trip } from '../../types'

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
// PERF GUARD: the all-trips map (and the Google Maps JS bundle it pulls in) is
// lazy-loaded AND only mounted when mode === 'trips'. States-only users never
// download the maps bundle or load any tiles — the Dashboard stays map-free
// until a user explicitly flips to Trips.
const AllTripsMap = lazy(() => import('./AllTripsMap'))

const COLLAPSE_KEY = 'roamready-journal-map-collapsed'
const PINS_KEY = 'roamready-journal-pins-shown'
const MODE_KEY = 'roamready-journal-map-mode'

type MapMode = 'states' | 'trips'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true'
  } catch {
    return false
  }
}

// Pins default OFF (key absent → false); only 'true' turns them on.
function readPinsShown(): boolean {
  try {
    return localStorage.getItem(PINS_KEY) === 'true'
  } catch {
    return false
  }
}

// Map mode defaults to 'states' (key absent → states); only 'trips' flips it.
function readMapMode(): MapMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'trips' ? 'trips' : 'states'
  } catch {
    return 'states'
  }
}

interface Props {
  overnight: Set<string>
  passthrough: Set<string>
  visitedCount: number
  stateMeta: Map<string, StateMeta>
  /** Re-runs visitedStatesApi.list() so the map/counter update after an edit. */
  refetchManualStates: () => void
  /** Full journal entry set — projected to pins when the toggle is on. */
  entries: JournalEntry[]
  /** All trips (with stop coords) — fed to the inline trips mini-map. Already
   *  loaded by JournalTabContent for the choropleth derivation; no refetch. */
  trips: Trip[]
}

export default function VisitedStatesBanner({
  overnight,
  passthrough,
  visitedCount,
  stateMeta,
  refetchManualStates,
  entries,
  trips,
}: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [editOpen, setEditOpen] = useState(false)
  const [showPins, setShowPins] = useState(readPinsShown)
  const [mapMode, setMapMode] = useState<MapMode>(readMapMode)
  const navigate = useNavigate()
  const hasAccess = useAuthStore(s => s.hasAccess)
  const openPaywall = useUIStore(s => s.openPaywall)

  // Gate at the entry point (tap), not mid-edit: a non-Pro user never enters the
  // editor. Reading the map stays open to all; only editing is Pro-gated.
  function handleEdit() {
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    setEditOpen(true)
  }

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

  // Pins are display-only — no gating. Persist the preference across sessions.
  function togglePins() {
    setShowPins(prev => {
      const next = !prev
      try {
        localStorage.setItem(PINS_KEY, String(next))
      } catch {
        /* storage unavailable — pref just won't persist */
      }
      return next
    })
  }

  // Persist the States/Trips choice across sessions.
  function selectMode(mode: MapMode) {
    setMapMode(mode)
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      /* storage unavailable — pref just won't persist */
    }
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
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            {/* States / Trips segmented switch — flips the map area below. */}
            <div className="inline-flex gap-0.5 bg-gray-100 rounded-lg p-0.5" role="tablist" aria-label="Map mode">
              {(['states', 'trips'] as const).map(mode => (
                <button
                  key={mode}
                  role="tab"
                  aria-selected={mapMode === mode}
                  onClick={() => selectMode(mode)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    mapMode === mode
                      ? 'bg-[#1F6F8B] text-white'
                      : 'text-gray-600 hover:text-[#1F6F8B]'
                  }`}
                >
                  {mode === 'states' ? 'States' : 'Trips'}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              {/* Reading the all-trips memory map is open to all — no gating.
                  Stays visible in both modes. */}
              <button
                onClick={() => navigate('/journal/map')}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1F6F8B] hover:underline"
              >
                <Globe size={12} /> View full map
              </button>
              {/* Show pins / Edit my states are States-only controls. */}
              {mapMode === 'states' && (
                <>
                  <button
                    onClick={togglePins}
                    aria-pressed={showPins}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium transition-colors ${
                      showPins ? 'text-[#C9851A]' : 'text-gray-500 hover:text-[#1F6F8B]'
                    }`}
                  >
                    <MapPin size={12} /> {showPins ? 'Hide pins' : 'Show pins'}
                  </button>
                  <button
                    onClick={handleEdit}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1F6F8B] hover:underline"
                  >
                    <Pencil size={12} /> Edit my states
                  </button>
                </>
              )}
            </div>
          </div>

          {mapMode === 'states' ? (
            <Suspense
              fallback={<div className="h-48 rounded-lg bg-gray-50 animate-pulse" aria-hidden="true" />}
            >
              <JournalStatesMap
                overnight={overnight}
                passthrough={passthrough}
                visitedCount={visitedCount}
                entries={entries}
                showPins={showPins}
              />
            </Suspense>
          ) : (
            // Lazy + mounted ONLY here (mode === 'trips') so States-only users
            // never download the Google Maps bundle or load tiles.
            <Suspense
              fallback={<div className="h-48 rounded-lg bg-gray-50 animate-pulse" aria-hidden="true" />}
            >
              <AllTripsMap
                trips={trips}
                entries={entries}
                showControls={false}
                className="h-48 rounded-lg overflow-hidden border border-gray-100"
              />
            </Suspense>
          )}
        </div>
      )}

      {editOpen && (
        <EditStatesModal
          stateMeta={stateMeta}
          onChanged={refetchManualStates}
          onClose={() => setEditOpen(false)}
        />
      )}
    </div>
  )
}
