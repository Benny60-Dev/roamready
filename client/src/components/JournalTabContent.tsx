import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, Star, MapPin, Pencil, Trash2, X } from 'lucide-react'
import { journalApi, visitedStatesApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'
import { JournalEntry, Trip } from '../types'
import { formatTripDate, toYmd } from '../utils/dates'
import { deriveTripStatus } from '../utils/tripStatus'
import { normalizeStateCode, STATE_CODES, type StateTier, type StateMeta } from './journal/stateUtils'
import VisitedStatesBanner from './journal/VisitedStatesBanner'

interface ManualState {
  state: string
  visitType: string
}

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
  // Edit mode reuses the same modal; non-null = editing that entry.
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null)

  // Server full-text search (step 5 phase 3). searchResults is null when the
  // box is empty (feed shows the full `entries` set); an array when a search is
  // active. The full `entries` fetch is NEVER replaced by this — it still drives
  // the map derivation, the count line, and the chip base set.
  const [searchResults, setSearchResults] = useState<JournalEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)

  const hasAccess = useAuthStore(s => s.hasAccess)
  const openPaywall = useUIStore(s => s.openPaywall)

  // Gate the write entry-point at TAP time, not submit time: a non-Pro user
  // should see the upgrade prompt the moment they tap "+ Add entry", never
  // after filling out a full entry. Uses the same client mirror of the server
  // hasAccess('tripJournal') check (server enforces it again via
  // requireFeature('tripJournal') on POST /journal). The global 403 interceptor
  // stays as a safety net for stale client state.
  function handleAddEntry() {
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    setComposerOpen(true)
  }

  // Edit affordance — same tap-time Pro gate as create; opens the shared modal
  // in edit mode. Reading is open, but mutating an entry is a gated write.
  function handleEditEntry(e: JournalEntry) {
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    setEditingEntry(e)
  }

  // Delete affordance — confirm, then DELETE /journal/:id (removes ONLY the
  // JournalEntry row; any linked stop is untouched), then reload the feed.
  async function handleDeleteEntry(entryId: string) {
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    if (!window.confirm("Delete this journal entry? This can't be undone.")) return
    try {
      await journalApi.delete(entryId)
      load()
    } catch (e: any) {
      if (e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED') return
      console.error('[JournalTabContent] delete failed:', e)
    }
  }

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

  // Manual visited-state marks (step 6b). Fetched separately from the feed so
  // the editor (phase 4) can refetch just these after a mutation without
  // reloading the whole journal. A failure is non-fatal — the map falls back to
  // derived-only. refetchManualStates is the callback phase 4's editor calls.
  const [manualStates, setManualStates] = useState<ManualState[]>([])
  function refetchManualStates() {
    visitedStatesApi
      .list()
      .then(res => setManualStates(res.data))
      .catch(() => {
        /* non-fatal: map shows derived-only */
      })
  }
  useEffect(() => {
    refetchManualStates()
  }, [])

  // Debounced server full-text search. When the box has text, hit the FTS
  // endpoint (journalApi.list({ q })) ~275ms after the last keystroke and render
  // those results in the feed. Empty box → no call, feed shows the full set.
  // searchSeq guards against out-of-order / stale responses.
  useEffect(() => {
    const q = search.trim()
    if (!q) {
      searchSeq.current++ // invalidate any in-flight response
      setSearchResults(null)
      setSearching(false)
      return
    }
    const seq = ++searchSeq.current
    setSearching(true)
    const t = setTimeout(() => {
      journalApi
        .list({ q })
        .then(res => {
          if (seq !== searchSeq.current) return // stale — a newer query superseded this
          setSearchResults(res.data)
          setSearching(false)
        })
        .catch(() => {
          if (seq !== searchSeq.current) return
          setSearchResults([]) // treat a failed search as no matches
          setSearching(false)
        })
    }, 275)
    return () => clearTimeout(t)
  }, [search])

  // Count line — states/trips counted across ALL entries (not the filtered
  // view) so the header reads as a stable summary of the whole journal.
  const stateCount = new Set(entries.filter(e => e.state).map(e => e.state)).size
  const tripCount = new Set(entries.filter(e => e.tripId).map(e => e.tripId)).size

  // Feed source: server FTS results when searching, else the full set. The map
  // memo + count line ALWAYS read the full `entries` set (never this) — search
  // narrows only the visible feed, not the map/counts.
  const isSearching = search.trim().length > 0
  const baseEntries = isSearching ? (searchResults ?? []) : entries
  // Show the searching state until the first results for the current query land
  // (covers the pre-effect render + debounce + fetch); once results exist we keep
  // them visible (with the inline "Searching…" hint) while a newer query loads.
  const showSearchingState = isSearching && searchResults === null

  // Chip filters run client-side on the displayed set (locked: chips client-side
  // for v1). The search box no longer filters client-side — server FTS does it.
  const filtered = baseEntries.filter(e => {
    if (filter === 'trip' && !e.tripId) return false
    if (filter === 'state' && !e.state) return false
    if (filter === 'campgrounds' && !(e.tags || []).some(t => t.toLowerCase().includes('campground'))) return false
    if (filter === 'loved' && !(e.rating != null && e.rating >= 4)) return false
    return true
  })

  // Sort entryDate desc (ISO strings sort lexically in chronological order).
  const sorted = [...filtered].sort((a, b) =>
    a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : 0,
  )

  // ── Visited-states rollup (derived + manual; matches the Dashboard) ───────
  //   DERIVED (date-derived via deriveTripStatus — NOT the stale stored
  //   Trip.status enum — so the map agrees with the Dashboard's Completed tab):
  //     overnight   = completed-trip stops (non-HOME, nights >= 1)
  //     passthrough = completed-trip stops with nights === 0, PLUS journal
  //                   entries with a state — minus any already overnight
  //   MANUAL marks (step 6b) fold in with the locked rule:
  //     derived-overnight is authoritative — a manual mark on such a state is
  //     IGNORED (can't downgrade earned data). Otherwise overnight always wins
  //     over passthrough in the final merge.
  //   counter = (finalOvernight ∪ finalPassthrough), excluding DC, of 50.
  //   stateMeta exposes per-state { derivedTier, manualTier, locked } for the
  //   phase-4 editor (consumed there; returned here so it's ready).
  const { overnight, passthrough, visitedCount, stateMeta } = useMemo(() => {
    // Derived sets.
    const derivedOvernight = new Set<string>()
    const derivedPassthrough = new Set<string>()
    for (const trip of trips) {
      if (deriveTripStatus(trip) !== 'COMPLETED') continue
      for (const stop of trip.stops || []) {
        if (stop.type === 'HOME') continue
        const code = normalizeStateCode(stop.locationState)
        if (!code) continue
        if (stop.nights >= 1) derivedOvernight.add(code)
        else derivedPassthrough.add(code)
      }
    }
    for (const e of entries) {
      const code = normalizeStateCode(e.state)
      if (code) derivedPassthrough.add(code)
    }
    for (const code of derivedOvernight) derivedPassthrough.delete(code)

    // Raw manual marks (kept for the editor's display, independent of the lock).
    const rawManual = new Map<string, StateTier>()
    for (const m of manualStates) {
      const code = normalizeStateCode(m.state)
      if (!code) continue
      rawManual.set(code, m.visitType === 'overnight' ? 'overnight' : 'passthrough')
    }

    // Apply manual marks with the lock rule, then resolve overnight-wins.
    const finalOvernight = new Set<string>(derivedOvernight)
    const finalPassthrough = new Set<string>(derivedPassthrough)
    for (const [code, tier] of rawManual) {
      if (derivedOvernight.has(code)) continue // locked — manual can't downgrade
      if (tier === 'overnight') finalOvernight.add(code)
      else finalPassthrough.add(code)
    }
    for (const code of finalOvernight) finalPassthrough.delete(code) // overnight wins

    // Counter is over the 50 states — DC is shown on the map but doesn't count.
    const union = new Set<string>([...finalOvernight, ...finalPassthrough])
    union.delete('DC')

    // Per-state metadata for the editor.
    const meta = new Map<string, StateMeta>()
    for (const code of STATE_CODES) {
      meta.set(code, {
        derivedTier: derivedOvernight.has(code)
          ? 'overnight'
          : derivedPassthrough.has(code)
            ? 'passthrough'
            : 'none',
        manualTier: rawManual.get(code) ?? 'none',
        locked: derivedOvernight.has(code),
      })
    }

    return {
      overnight: finalOvernight,
      passthrough: finalPassthrough,
      visitedCount: union.size,
      stateMeta: meta,
    }
  }, [trips, entries, manualStates])

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
      {/* Visited-states choropleth (collapsible; lazy-loads its geometry). */}
      <VisitedStatesBanner
        overnight={overnight}
        passthrough={passthrough}
        visitedCount={visitedCount}
        stateMeta={stateMeta}
        refetchManualStates={refetchManualStates}
        entries={entries}
        trips={trips}
      />

      {/* Count line + Add entry */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-500">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'} · {stateCount}{' '}
          {stateCount === 1 ? 'state' : 'states'} · {tripCount} {tripCount === 1 ? 'trip' : 'trips'}
        </p>
        <button
          onClick={handleAddEntry}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors bg-[#F7A829] hover:bg-[#C9851A]"
        >
          <Plus size={16} /> Add entry
        </button>
      </div>

      {/* Search (server full-text search) */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          className="input pl-8"
          placeholder="Search your journal..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-gray-400">
            Searching…
          </span>
        )}
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
            onClick={handleAddEntry}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors bg-[#F7A829] hover:bg-[#C9851A]"
          >
            <Plus size={15} /> Add entry
          </button>
        </div>
      ) : showSearchingState ? (
        <div className="space-y-2">
          {[1, 2].map(i => (
            <div key={i} className="card h-20 animate-pulse bg-gray-50" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-gray-500">
            {isSearching ? `No entries match “${search.trim()}”.` : 'No entries match this filter.'}
          </p>
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
                  <EntryCard key={e.id} entry={e} onEdit={handleEditEntry} onDelete={handleDeleteEntry} />
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

      {editingEntry && (
        <AddEntryModal
          entry={editingEntry}
          onClose={() => setEditingEntry(null)}
          onCreated={() => {
            setEditingEntry(null)
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

export function EntryCard({
  entry,
  showRemovedStopOrigin,
  onEdit,
  onDelete,
}: {
  entry: JournalEntry
  showRemovedStopOrigin?: boolean
  // Opt-in actions (mirrors showRemovedStopOrigin): when a parent passes these,
  // the card renders Edit/Delete affordances and delegates the work upward. The
  // card stays presentational — confirm + journalApi calls + reload live in the
  // parent. Cards rendered without these props (none today, but keep it safe)
  // are read-only exactly as before.
  onEdit?: (entry: JournalEntry) => void
  onDelete?: (entryId: string) => void
}) {
  // Per scope: per-stop entries (stopId present) get a blue left-edge; freeform
  // / standalone entries get a gold left-edge with a pencil marker. Pine
  // (#3E5540) is reserved and intentionally NOT used here.
  const isStopEntry = !!entry.stopId
  const edgeColor = isStopEntry ? '#1F6F8B' : '#F7A829'

  // Orphaned per-stop entry: the stop was deleted (FK SetNull cleared stopId)
  // but the save path denormalized the stop's name into placeName, so we can
  // still say where it came from. Opt-in (TripJournalPage's freeform list)
  // because a placeName on a stop-less entry only implies a removed stop in
  // that context — authored freeform entries never carry one.
  const isRemovedStopEntry = !!showRemovedStopOrigin && !isStopEntry && !!entry.placeName

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
          ) : isRemovedStopEntry ? (
            <h3 className="text-sm font-medium text-gray-900 truncate">{entry.placeName}</h3>
          ) : (
            !isStopEntry && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#C9851A]">
                <Pencil size={11} aria-hidden="true" /> Freeform
              </span>
            )
          )}
          {isRemovedStopEntry && (
            <p className="text-[11px] text-gray-400 italic mt-0.5">
              from a removed stop{entry.state ? ` · ${entry.placeName}, ${entry.state}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <span className="text-[11px] text-gray-400">
            {formatTripDate(entry.entryDate, 'MMM d, yyyy')}
          </span>
          {onEdit && (
            <button
              type="button"
              onClick={() => onEdit(entry)}
              className="p-1 rounded-md text-gray-400 hover:text-[#1F6F8B] hover:bg-gray-100 transition-colors"
              aria-label="Edit entry"
              title="Edit entry"
            >
              <Pencil size={14} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(entry.id)}
              className="p-1 rounded-md text-gray-400 hover:text-red-600 hover:bg-gray-100 transition-colors"
              aria-label="Delete entry"
              title="Delete entry"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
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

/** Journal entry composer. Creates a standalone (trip-less) entry via
 *  POST /journal, OR — when an `entry` is passed — edits it in place via
 *  PUT /journal/:id. Body required; title/rating/tags/date optional. */
export function AddEntryModal({
  onClose,
  onCreated,
  link,
  entry,
}: {
  onClose: () => void
  onCreated: () => void
  /** Optional links merged into the create payload. The Dashboard composer omits
   *  this (standalone entry); the in-trip freeform button passes
   *  { tripId, stopId: null } so the entry attaches to the trip but no stop.
   *  Ignored in edit mode (the entry's links don't change). */
  link?: { tripId?: string; stopId?: string | null }
  /** When present, the modal is in EDIT mode: fields pre-fill from this entry
   *  and Save calls journalApi.update(entry.id, …) instead of create. */
  entry?: JournalEntry
}) {
  const isEdit = !!entry
  const [title, setTitle] = useState(entry?.title ?? '')
  const [body, setBody] = useState(entry?.body ?? '')
  const [rating, setRating] = useState<number | null>(entry?.rating ?? null)
  const [tagsInput, setTagsInput] = useState((entry?.tags ?? []).join(', '))
  const [entryDate, setEntryDate] = useState(
    entry?.entryDate ? toYmd(new Date(entry.entryDate)) : toYmd(new Date()),
  )
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
      if (isEdit) {
        // Edit: PUT the mutable fields. Links (tripId/stopId) are intentionally
        // not sent — editing text shouldn't move an entry between trip/stop.
        await journalApi.update(entry!.id, {
          body: body.trim(),
          title: title.trim() || null,
          rating: rating ?? null,
          tags,
          entryDate: entryDate || undefined,
        })
      } else {
        await journalApi.create({
          body: body.trim(),
          title: title.trim() || undefined,
          rating: rating ?? undefined,
          tags: tags.length ? tags : undefined,
          entryDate: entryDate || undefined,
          ...(link ?? {}),
        })
      }
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
          <h2 className="font-medium text-gray-900">{isEdit ? 'Edit journal entry' : 'New journal entry'}</h2>
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
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save entry'}
          </button>
        </div>
      </div>
    </div>
  )
}
