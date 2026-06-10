import { useEffect, useState, Fragment } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus, Search, Calendar, BookOpen } from 'lucide-react'
import { tripsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { Trip } from '../types'
import TripCard from '../components/trip/TripCard'
import ConfirmModal from '../components/ui/ConfirmModal'
import ReservationsTabContent from '../components/dashboard/ReservationsTabContent'
import JournalTabContent from '../components/JournalTabContent'
import { deriveTripStatus } from '../utils/tripStatus'
import { getSalutation } from '../utils/greeting'
import { useScrollResetOnReady } from '../hooks/useScrollResetOnReady'

// Tabs are data-driven via a discriminated union — three trip-status tabs
// share a Trip-filter predicate, the Reservations tab renders different
// content from a different unit of display (stops, not trips) so it carries
// no `filter` field. The render code branches on `mode`.
type TabKey = 'active' | 'completed' | 'all' | 'reservations' | 'journal'

type TabEntry =
  | { key: 'active' | 'completed' | 'all'; label: string; mode: 'trips'; filter: (t: Trip) => boolean }
  | { key: 'reservations'; label: string; mode: 'reservations' }
  | { key: 'journal'; label: string; mode: 'journal' }

const TABS: TabEntry[] = [
  // "In Progress" = anything currently in motion or being planned. Both
  // PLANNING and ACTIVE rows fold here since they're both "trips the user
  // cares about right now". Tab key stays 'active' for state-handler
  // continuity; label became "In Progress" in the Block 3 follow-up so it
  // no longer reads as the ACTIVE status enum value.
  { key: 'active',    label: 'In Progress', mode: 'trips', filter: t => { const s = deriveTripStatus(t); return s === 'ACTIVE' || s === 'PLANNING' } },
  { key: 'completed', label: 'Completed',   mode: 'trips', filter: t => deriveTripStatus(t) === 'COMPLETED' },
  // "All" intentionally includes DRAFT trips even though no code path currently
  // writes that status — keeps a forward-compatible escape hatch the moment
  // the resume-incomplete-trip UX ships.
  { key: 'all',       label: 'All',         mode: 'trips', filter: () => true },
  // Reservations (Block 5) — different lens onto the same data. The tab bar
  // renders a divider + leading Calendar icon ahead of this entry so the
  // visual break signals "bookings, not trip-status". Content is per-stop
  // (ReservationsTabContent) rather than the per-trip grid the other three
  // tabs share.
  { key: 'reservations', label: 'Reservations', mode: 'reservations' },
  // Journal (freeform travel diary) — another "different lens" tab. Like
  // Reservations it renders its own content component (JournalTabContent) which
  // fetches its own entries; it shares the lens-divider that precedes the
  // Reservations tab rather than introducing a second one.
  { key: 'journal', label: 'RoamReady Journal', mode: 'journal' },
]

// Reservations tab count — number of bookable stops across all trips with
// status CONFIRMED/PENDING/WAITLISTED (matches the row filter inside
// ReservationsTabContent so the count never disagrees with the content).
function countReservations(trips: Trip[]): number {
  return trips
    .flatMap(t => t.stops || [])
    .filter(s =>
      s.type !== 'HOME' &&
      (s.bookingStatus === 'CONFIRMED' ||
        s.bookingStatus === 'PENDING' ||
        s.bookingStatus === 'WAITLISTED')
    ).length
}

export default function DashboardPage() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // ── Active tab is derived from the URL (?tab=...) rather than local state,
  //    so direct links and the /reservations redirect can deep-link into a
  //    specific tab. setActiveTab writes back into the URL via replace (no
  //    history pollution as the user clicks between tabs), and clears the
  //    param when returning to the default 'active' tab so /dashboard URLs
  //    stay clean for the most common state.
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const activeTab: TabKey =
    TABS.some(t => t.key === requestedTab) ? (requestedTab as TabKey) : 'active'
  function setActiveTab(key: TabKey) {
    if (key === 'active') {
      // Default tab — drop the query param entirely.
      const next = new URLSearchParams(searchParams)
      next.delete('tab')
      setSearchParams(next, { replace: true })
    } else {
      const next = new URLSearchParams(searchParams)
      next.set('tab', key)
      setSearchParams(next, { replace: true })
    }
  }

  // ConfirmModal target for the Delete flow. Holding the full Trip (not just the
  // id) so the modal message can include the trip name without a second lookup.
  const [deleteTarget, setDeleteTarget] = useState<Trip | null>(null)
  const [deleting, setDeleting] = useState(false)

  const { user } = useAuthStore()

  // Time-aware salutation, same hour buckets as the Home greeting. Computed
  // once per mount; the late-night variant reads as a question ("Up late,
  // Benny?") so it gets its own punctuation branch in the h1.
  const salutation = getSalutation()

  useEffect(() => {
    tripsApi.getAll()
      .then(res => { setTrips(res.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  // Reset window scroll to the top on the loading→ready edge when the tall trip
  // grid first mounts. See hooks/useScrollResetOnReady for the full rationale.
  useScrollResetOnReady(!loading)

  // ── Filtering ────────────────────────────────────────────────────────────────
  //   Only the three trip-status tabs filter trips; the Reservations tab
  //   carries no `filter` field (it renders ReservationsTabContent which
  //   does its own per-stop derivation). The discriminated union narrows
  //   currentTab.filter behind the mode check.
  const currentTab = TABS.find(t => t.key === activeTab) ?? TABS[0]
  const searchLower = search.trim().toLowerCase()
  const filteredTrips =
    currentTab.mode === 'trips'
      ? trips
          .filter(currentTab.filter)
          .filter(t => {
            if (!searchLower) return true
            return (
              t.name.toLowerCase().includes(searchLower) ||
              t.startLocation.toLowerCase().includes(searchLower)
            )
          })
      : []

  // ── Trial banner ────────────────────────────────────────────────────────────
  const isTrial = user?.trialEndsAt && new Date() < new Date(user.trialEndsAt)
  const trialDaysLeft = user?.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(user.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0

  // ── Delete flow (replaces TripsPage's window.confirm) ───────────────────────
  // Called by TripCard's onDelete prop with just the trip id; we look up the
  // full record so the ConfirmModal can name the trip in its message.
  function openDeleteConfirm(id: string) {
    const target = trips.find(t => t.id === id)
    if (target) setDeleteTarget(target)
  }
  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await tripsApi.delete(deleteTarget.id)
      setTrips(prev => prev.filter(t => t.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (err) {
      // Non-fatal — leave the modal open so the user can retry, surface
      // the error inline via console for now (no toast system yet).
      console.error('[DashboardPage] delete failed:', err)
    } finally {
      setDeleting(false)
    }
  }
  function cancelDelete() {
    if (deleting) return
    setDeleteTarget(null)
  }

  // ── Empty-state message — contextual to whether trips exist, whether the
  //     current tab is empty, or whether the search is the reason nothing shows.
  function emptyStateMessage(): { title: string; body: string; showCta: boolean } {
    if (trips.length === 0) {
      return { title: 'No trips yet', body: 'Start planning your next adventure.', showCta: true }
    }
    if (searchLower) {
      return { title: 'No trips match', body: 'Try a different search or switch tabs.', showCta: false }
    }
    // Tab-specific copy when the user has trips but none in the current tab.
    // Typed only over the trip-status keys — the Reservations tab branches to
    // ReservationsTabContent before this function is ever consulted, so its
    // own empty-state copy lives there.
    type TripTabKey = 'active' | 'completed' | 'all'
    const tabCopy: Record<TripTabKey, { title: string; body: string }> = {
      active:    { title: 'No active trips',    body: 'Plan a new one or check the Completed tab.' },
      completed: { title: 'No completed trips yet', body: 'Your past adventures will appear here.' },
      all:       { title: 'No trips yet',       body: 'Start planning your next adventure.' },
    }
    // Reservations/Journal tabs branch to their own content before this runs;
    // map them to 'active' defensively so the cast never indexes tabCopy with a
    // non-trip key.
    const key = (activeTab === 'reservations' || activeTab === 'journal' ? 'active' : activeTab) as TripTabKey
    return { ...tabCopy[key], showCta: key !== 'completed' }
  }

  return (
    <div className="space-y-6">
      {/* Trial banner — unchanged from previous Dashboard. */}
      {isTrial && user?.subscriptionTier === 'FREE' && (
        <div className="bg-[#E0F0F4] border border-[#1F6F8B]/20 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-[#134756]">🎉 Pro trial active — {trialDaysLeft} days left</p>
            <p className="text-xs text-[#1F6F8B] mt-0.5">All Pro features unlocked. Upgrade to keep them.</p>
          </div>
          <Link to="/profile/billing/upgrade" className="btn-primary text-sm">Upgrade</Link>
        </div>
      )}

      {/* Header — greeting + gold "Plan a new trip" CTA that loops back to the
          Home canvas. Same target as the Home nav (/sessions/new → resume-or-
          create → /sessions/:id). */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-medium text-gray-900">
            {salutation === 'Up late'
              ? <>Up late, {user?.firstName}?</>
              : <>{salutation}, {user?.firstName}</>}
          </h1>
          <p className="text-sm text-gray-500">Your trip dashboard</p>
        </div>
        <Link
          to="/sessions/new"
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors bg-[#F7A829] hover:bg-[#C9851A]"
        >
          <Plus size={16} /> Plan a new trip
        </Link>
      </div>

      {/* Search + tab bar. Same row on wide screens; wraps to a second line on
          narrow. Tab counts use the unfiltered trip set (or per-stop reservation
          count for the Reservations tab) so they stay stable as the user types
          in the search box — search narrows WITHIN the active trip-status tab.
          Search input is hidden on the Reservations tab since it'd be a no-op
          there (the row derivation isn't search-aware in this block; cleaner
          to not display a non-functional control). */}
      <div className="flex gap-2 flex-wrap">
        {currentTab.mode === 'trips' && (
          <div className="relative flex-1 min-w-48">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              className="input pl-8"
              placeholder="Search trips..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        )}
        <div className="flex gap-1 flex-wrap items-center" role="tablist" aria-label="Dashboard view">
          {TABS.map(tab => {
            const isReservationsTab = tab.mode === 'reservations'
            const isJournalTab = tab.mode === 'journal'
            // Count: per-stop reservation count for Reservations; trip count for
            // the status tabs; null for Journal (its entries aren't fetched at
            // this level — JournalTabContent owns that data), so its pill shows
            // no number. Direct discriminant checks let TS narrow tab.filter.
            const count =
              tab.mode === 'reservations'
                ? countReservations(trips)
                : tab.mode === 'journal'
                  ? null
                  : trips.filter(tab.filter).length
            const isActive = tab.key === activeTab
            return (
              <Fragment key={tab.key}>
                {/* Thin vertical divider before the Reservations tab — signals
                    the shift to a different lens (bookings/journal, not
                    trip-status). Journal sits after Reservations under the same
                    divider, so it doesn't add its own. */}
                {isReservationsTab && (
                  <span aria-hidden className="w-px self-stretch bg-gray-200 mx-1" />
                )}
                <button
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-[#1F6F8B] text-white'
                      : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                  style={{ borderWidth: '0.5px' }}
                >
                  {/* Leading icon on the lens tabs to reinforce the framing. */}
                  {isReservationsTab && <Calendar size={12} className="opacity-70" />}
                  {isJournalTab && <BookOpen size={12} className="opacity-70" />}
                  {tab.label}
                  {count !== null && <span className="opacity-70">{count}</span>}
                </button>
              </Fragment>
            )
          })}
        </div>
      </div>

      {/* Trip list */}
      {/* Content. Reservations tab routes its own roll-up component;
          trip-status tabs use the shared loading/empty/grid branches. */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-50" />)}
        </div>
      ) : currentTab.mode === 'reservations' ? (
        <ReservationsTabContent trips={trips} />
      ) : currentTab.mode === 'journal' ? (
        <JournalTabContent trips={trips} />
      ) : filteredTrips.length === 0 ? (
        (() => {
          const { title, body, showCta } = emptyStateMessage()
          return (
            <div className="card text-center py-12">
              <div className="text-4xl mb-3">🗺️</div>
              <p className="font-medium text-gray-700 mb-1">{title}</p>
              <p className="text-sm text-gray-500 mb-4">{body}</p>
              {showCta && (
                <Link
                  to="/sessions/new"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors bg-[#F7A829] hover:bg-[#C9851A]"
                >
                  <Plus size={15} /> Plan a new trip
                </Link>
              )}
            </div>
          )
        })()
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filteredTrips.map(trip => (
            <TripCard
              key={trip.id}
              trip={trip}
              variant="grid"
              showRelative
              onDelete={openDeleteConfirm}
            />
          ))}
        </div>
      )}

      {/* Block 4 retired the Quick Actions tile row that used to live here
          (Maintenance / Bookings / Resources / Roadmap). Maintenance, Resources,
          and Roadmap moved to the /resources hub. Bookings returned in Block 5
          as the Reservations tab above; the /reservations URL still resolves
          via a Navigate redirect in App.tsx that targets ?tab=reservations. */}

      {/* Delete confirmation — reuses the existing ConfirmModal (also used for
          Discard plan on SessionPage and the Unbook flow). Replaces TripsPage's
          legacy window.confirm() dialog. */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        title="Delete this trip?"
        message={
          deleteTarget
            ? `"${deleteTarget.name}" will be permanently removed. This can't be undone.`
            : ''
        }
        confirmLabel="Delete trip"
        cancelLabel="Keep trip"
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
        danger
        isConfirming={deleting}
      />
    </div>
  )
}
