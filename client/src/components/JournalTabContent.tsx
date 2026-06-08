import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Star, MapPin, Pencil, X } from 'lucide-react'
import { journalApi } from '../services/api'
import { JournalEntry, Trip } from '../types'
import { formatTripDate, toYmd } from '../utils/dates'

/**
 * Journal tab content — the freeform travel-diary feed (Block: Journal step 4).
 *
 * Mirrors ReservationsTabContent's prop-driven, co-located-subcomponents shape,
 * with one difference: Reservations reuses the Dashboard's already-fetched
 * trips, but the Journal feed has its own data source (GET /journal), so this
 * component fetches its own entries on mount with loading/empty/error states.
 *
 * The `trips` prop is used only to resolve tripId → trip name for grouping —
 * the Dashboard already has it in hand, so we pass it down rather than fetch
 * trips a second time.
 *
 * Reads are open to all authenticated users; the "+ Add entry" write is
 * Pro-gated server-side. A non-Pro user's create returns 403 FEATURE_GATED,
 * which the global axios interceptor turns into the shared PaywallModal — the
 * composer just suppresses its own error so the paywall isn't double-narrated.
 *
 * NO map yet (step 6). A clean spot is reserved at the top of the layout.
 */

interface Props {
  trips: Trip[]
}

type FilterKey = 'all' | 'trip' | 'state' | 'campgrounds' | 'loved'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'trip', label: 'By trip' },
  { key: 'state', label: 'By state' },
  { key: 'campgrounds', label: 'Campgrounds' },
  { key: 'loved', label: 'Loved' },
]

const GENERAL_GROUP = '__general__'

export default function JournalTabContent({ trips }: Props) {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [composerOpen, setComposerOpen] = useState(false)

  const tripNameById = useMemo(() => {
    const m = new Map<string, string>()
    trips.forEach(t => m.set(t.id, t.name))
    return m
  }, [trips])

  function load() {
    setLoading(true)
    setError(false)
    journalApi
      .list()
      .then(res => {
        setEntries(res.data)
        setLoading(false)
      })
      .catch(() => {
        setError(true)
        setLoading(false)
      })
  }
  useEffect(() => {
    load()
  }, [])

  // Count line — states/trips counted across ALL entries (not the filtered
  // view) so the header reads as a stable summary of the whole journal.
  const stateCount = new Set(entries.filter(e => e.state).map(e => e.state)).size
  const tripCount = new Set(entries.filter(e => e.tripId).map(e => e.tripId)).size

  // ── Client-side filter (search + chips). Kept client-side for v1: the feed
  //    is small and already fully fetched, so round-tripping the q/filter params
  //    to the server would add latency without benefit. The list endpoint's
  //    query params are wired and ready for when the feed grows large enough to
  //    paginate.
  const searchLower = search.trim().toLowerCase()
  const filtered = entries.filter(e => {
    if (filter === 'trip' && !e.tripId) return false
    if (filter === 'state' && !e.state) return false
    if (filter === 'campgrounds' && !(e.tags || []).some(t => t.toLowerCase().includes('campground'))) return false
    if (filter === 'loved' && !(e.rating != null && e.rating >= 4)) return false
    if (searchLower) {
      const hay = `${e.title || ''} ${e.body || ''}`.toLowerCase()
      if (!hay.includes(searchLower)) return false
    }
    return true
  })

  // Sort entryDate desc (ISO strings sort lexically in chronological order).
  const sorted = [...filtered].sort((a, b) =>
    a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : 0,
  )

  // Group by trip; standalone (no tripId) entries fall into a trailing
  // "General" group. Map preserves insertion order, and we insert in
  // entryDate-desc order, so trip groups appear by their most-recent entry.
  const groupMap = new Map<string, JournalEntry[]>()
  sorted.forEach(e => {
    const key = e.tripId || GENERAL_GROUP
    if (!groupMap.has(key)) groupMap.set(key, [])
    groupMap.get(key)!.push(e)
  })
  const groups: { key: string; label: string; entries: JournalEntry[] }[] = []
  groupMap.forEach((groupEntries, key) => {
    if (key === GENERAL_GROUP) return
    groups.push({ key, label: tripNameById.get(key) || 'Trip', entries: groupEntries })
  })
  if (groupMap.has(GENERAL_GROUP)) {
    groups.push({ key: GENERAL_GROUP, label: 'General', entries: groupMap.get(GENERAL_GROUP)! })
  }

  return (
    <div className="space-y-5">
      {/* ── Map banner slots in here in step 6 — intentionally left empty. ── */}

      {/* Count line + Add entry */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-500">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'} · {stateCount}{' '}
          {stateCount === 1 ? 'state' : 'states'} · {tripCount} {tripCount === 1 ? 'trip' : 'trips'}
        </p>
        <button
          onClick={() => setComposerOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors bg-[#F7A829] hover:bg-[#C9851A]"
        >
          <Plus size={16} /> Add entry
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          className="input pl-8"
          placeholder="Search your journal..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Filter chips */}
      <div className="flex gap-1 flex-wrap items-center" role="tablist" aria-label="Journal filters">
        {FILTERS.map(f => {
          const isActive = f.key === filter
          return (
            <button
              key={f.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-[#1F6F8B] text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
              style={{ borderWidth: '0.5px' }}
            >
              {f.label}
            </button>
          )
        })}
      </div>

      {/* Feed */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="card h-20 animate-pulse bg-gray-50" />
          ))}
        </div>
      ) : error ? (
        <div className="card text-center py-12">
          <p className="text-sm text-gray-500 mb-3">Couldn't load your journal.</p>
          <button onClick={load} className="text-sm font-medium text-[#1F6F8B] hover:underline">
            Try again
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-4xl mb-3">📓</div>
          <p className="font-medium text-gray-700 mb-1">No journal entries yet</p>
          <p className="text-sm text-gray-500 mb-4">
            Capture a memory from the road — notes, ratings, and the places you loved.
          </p>
          <button
            onClick={() => setComposerOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors bg-[#F7A829] hover:bg-[#C9851A]"
          >
            <Plus size={15} /> Add entry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-gray-500">No entries match this filter.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(g => (
            <div key={g.key}>
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                {g.label}
              </h2>
              <div className="space-y-2">
                {g.entries.map(e => (
                  <EntryCard key={e.id} entry={e} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {composerOpen && (
        <AddEntryModal
          onClose={() => setComposerOpen(false)}
          onCreated={() => {
            setComposerOpen(false)
            load()
          }}
        />
      )}
    </div>
  )
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center" aria-label={`Rated ${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map(n => (
        <Star
          key={n}
          size={12}
          className={n <= rating ? 'text-[#F7A829]' : 'text-gray-300'}
          fill={n <= rating ? '#F7A829' : 'none'}
        />
      ))}
    </span>
  )
}

function EntryCard({ entry }: { entry: JournalEntry }) {
  // Per scope: per-stop entries (stopId present) get a blue left-edge; freeform
  // / standalone entries get a gold left-edge with a pencil marker. Pine
  // (#3E5540) is reserved and intentionally NOT used here.
  const isStopEntry = !!entry.stopId
  const edgeColor = isStopEntry ? '#1F6F8B' : '#F7A829'

  const body = (entry.body || '').trim()
  const snippet = body.length > 180 ? `${body.slice(0, 180)}…` : body
  const tags = entry.tags || []

  return (
    <div className="card" style={{ borderLeft: `3px solid ${edgeColor}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {entry.title ? (
            <h3 className="text-sm font-medium text-gray-900 truncate flex items-center gap-1.5">
              {!isStopEntry && (
                <Pencil size={12} className="text-[#C9851A] flex-shrink-0" aria-label="Freeform entry" />
              )}
              {entry.title}
            </h3>
          ) : (
            !isStopEntry && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#C9851A]">
                <Pencil size={11} aria-hidden="true" /> Freeform
              </span>
            )
          )}
        </div>
        <span className="text-[11px] text-gray-400 flex-shrink-0">
          {formatTripDate(entry.entryDate, 'MMM d, yyyy')}
        </span>
      </div>

      {snippet && <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-line">{snippet}</p>}

      {(entry.state || entry.rating != null || tags.length > 0) && (
        <div className="flex items-center gap-2 flex-wrap mt-1.5">
          {entry.state && (
            <span className="badge badge-blue text-xs inline-flex items-center gap-1">
              <MapPin size={10} aria-hidden="true" />
              {entry.state}
            </span>
          )}
          {entry.rating != null && <Stars rating={entry.rating} />}
          {tags.map(t => (
            <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** "+ Add entry" composer — creates a standalone (trip-less) entry via
 *  POST /journal. Body required; title/rating/tags/date optional. */
function AddEntryModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [rating, setRating] = useState<number | null>(null)
  const [tagsInput, setTagsInput] = useState('')
  const [entryDate, setEntryDate] = useState(toYmd(new Date()))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSave() {
    if (!body.trim()) {
      setErr('Write something first.')
      return
    }
    setSaving(true)
    setErr(null)
    const tags = tagsInput
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
    try {
      await journalApi.create({
        body: body.trim(),
        title: title.trim() || undefined,
        rating: rating ?? undefined,
        tags: tags.length ? tags : undefined,
        entryDate: entryDate || undefined,
      })
      onCreated()
    } catch (e: any) {
      // The global axios interceptor already opens the shared PaywallModal on a
      // 403 FEATURE_GATED (non-Pro user hitting the gated write). Close the
      // composer and suppress our own error so the paywall isn't double-narrated.
      if (e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED') {
        onClose()
        return
      }
      setErr('Could not save your entry. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl border border-gray-200 w-full max-w-lg p-6"
        style={{ borderWidth: '0.5px' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-medium text-gray-900">New journal entry</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <input
            className="input"
            placeholder="Title (optional)"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <textarea
            className="input resize-y"
            rows={4}
            placeholder="What happened? (required)"
            value={body}
            onChange={e => setBody(e.target.value)}
          />

          {/* Rating — click a star to set, click it again to clear. */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Rating</span>
            <span className="inline-flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(rating === n ? null : n)}
                  className="p-0.5"
                  aria-label={`${n} star${n === 1 ? '' : 's'}`}
                >
                  <Star
                    size={18}
                    className={rating != null && n <= rating ? 'text-[#F7A829]' : 'text-gray-300'}
                    fill={rating != null && n <= rating ? '#F7A829' : 'none'}
                  />
                </button>
              ))}
            </span>
            {rating != null && (
              <button
                type="button"
                onClick={() => setRating(null)}
                className="text-[11px] text-gray-400 hover:underline"
              >
                clear
              </button>
            )}
          </div>

          <input
            className="input"
            placeholder="Tags (comma-separated, e.g. campground, hike)"
            value={tagsInput}
            onChange={e => setTagsInput(e.target.value)}
          />

          <div>
            <label className="text-xs text-gray-500 block mb-1">Date</label>
            <input
              type="date"
              className="input"
              value={entryDate}
              onChange={e => setEntryDate(e.target.value)}
            />
          </div>

          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save entry'}
          </button>
        </div>
      </div>
    </div>
  )
}
