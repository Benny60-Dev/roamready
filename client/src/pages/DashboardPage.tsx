import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search, Map, Tent, Wrench, Package } from 'lucide-react'
import { tripsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { Trip } from '../types'
import TripCard from '../components/trip/TripCard'
import ConfirmModal from '../components/ui/ConfirmModal'

// Tabs are data-driven so Block 5 can drop in a "Reservations" entry as the
// fourth tab without touching the render code. Each tab supplies its own
// status predicate; the count next to the label uses that predicate against
// the unfiltered trip set (search narrows within a tab, it doesn't change
// what's available in others).
type TabKey = 'active' | 'completed' | 'all'

const TABS: Array<{ key: TabKey; label: string; filter: (t: Trip) => boolean }> = [
  // "Active" = anything currently in motion or being planned. The old Dashboard
  // surfaced PLANNING trips as the main list and rendered a single ACTIVE trip
  // in its own hero card; the merge folds both into one tab since they're both
  // "trips the user cares about right now". If a richer ACTIVE-trip surface is
  // wanted later, it can come back as a polish — not part of the 3b merge.
  { key: 'active',    label: 'Active',    filter: t => t.status === 'ACTIVE' || t.status === 'PLANNING' },
  { key: 'completed', label: 'Completed', filter: t => t.status === 'COMPLETED' },
  // "All" intentionally includes DRAFT trips even though no code path currently
  // writes that status — keeps a forward-compatible escape hatch the moment
  // the resume-incomplete-trip UX ships.
  { key: 'all',       label: 'All',       filter: () => true },
]

export default function DashboardPage() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('active')
  const [search, setSearch] = useState('')

  // ConfirmModal target for the Delete flow. Holding the full Trip (not just the
  // id) so the modal message can include the trip name without a second lookup.
  const [deleteTarget, setDeleteTarget] = useState<Trip | null>(null)
  const [deleting, setDeleting] = useState(false)

  const { user } = useAuthStore()

  useEffect(() => {
    tripsApi.getAll()
      .then(res => { setTrips(res.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  // ── Filtering ────────────────────────────────────────────────────────────────
  const currentTab = TABS.find(t => t.key === activeTab) ?? TABS[0]
  const searchLower = search.trim().toLowerCase()
  const filteredTrips = trips
    .filter(currentTab.filter)
    .filter(t => {
      if (!searchLower) return true
      return (
        t.name.toLowerCase().includes(searchLower) ||
        t.startLocation.toLowerCase().includes(searchLower)
      )
    })

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
    const tabCopy: Record<TabKey, { title: string; body: string }> = {
      active:    { title: 'No active trips',    body: 'Plan a new one or check the Completed tab.' },
      completed: { title: 'No completed trips yet', body: 'Your past adventures will appear here.' },
      all:       { title: 'No trips yet',       body: 'Start planning your next adventure.' },
    }
    return { ...tabCopy[activeTab], showCta: activeTab !== 'completed' }
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
          <h1 className="text-xl font-medium text-gray-900">Good morning, {user?.firstName}</h1>
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
          narrow. Tab counts use the unfiltered trip set so they don't shift as
          the user types in the search box — search narrows WITHIN the active
          tab. */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            className="input pl-8"
            placeholder="Search trips..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1" role="tablist" aria-label="Trip status">
          {TABS.map(tab => {
            const count = trips.filter(tab.filter).length
            const isActive = tab.key === activeTab
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-[#1F6F8B] text-white'
                    : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
                style={{ borderWidth: '0.5px' }}
              >
                {tab.label} <span className="opacity-70">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Trip list */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-50" />)}
        </div>
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

      {/* Quick actions — unchanged from previous Dashboard. */}
      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Quick actions</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { to: '/maintenance',  icon: Wrench,  label: 'Maintenance' },
            { to: '/reservations', icon: Tent,    label: 'Bookings' },
            { to: '/resources',    icon: Map,     label: 'Resources' },
            { to: '/roadmap',      icon: Package, label: 'Roadmap' },
          ].map(({ to, icon: Icon, label }) => (
            <Link
              key={to}
              to={to}
              className="card flex flex-col items-center gap-2 py-4 hover:border-[#1F6F8B]/30 transition-all"
            >
              <Icon size={18} className="text-[#1F6F8B]" />
              <span className="text-xs text-gray-600">{label}</span>
            </Link>
          ))}
        </div>
      </div>

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
