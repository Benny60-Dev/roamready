import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { Search, AlertTriangle, User as UserIcon, ChevronLeft, Repeat, Bookmark } from 'lucide-react'
import { adminApi } from '../../services/api'
import { parseTripDate } from '../../utils/dates'
import { CopyIcon, CopyForSupport } from '../../components/admin/Copy'

// ── Types (loose — mirrors the read-only admin envelope) ─────────────────────
interface Msg { role: string; content: string }
interface Stop { order: number; type: string; locationName: string; locationState: string | null; nights: number }
interface Session {
  id: string
  userId: string
  title: string | null
  messages: Msg[] | unknown
  partialTripData: any
  tripId: string | null
  status: string
  createdAt: string
  updatedAt: string
}
interface TripLite { id: string; name: string; status: string; startDate: string | null; stops: Stop[] }
interface UsageRow {
  callType: string
  model: string
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: string | number
  createdAt: string
  sessionId: string | null
  tripId: string | null
}
interface InspectEnvelope {
  user: { email: string; firstName: string; lastName: string } | null
  sessions: Session[]
  trip: TripLite | null
  trips: TripLite[]
  aiUsageLogs: UsageRow[]
}

// CHAT max_tokens cap (services/ai.ts). An output near this MAY be truncated —
// stop_reason is NOT stored, so we can only flag the suspicion, never confirm.
const CHAT_CAP = 8192
const CHAT_NEAR_CAP = 7800

// Mirror of the client-side parseItinerary in SessionPage.tsx — extracts the
// <itinerary> JSON from one assistant message. Read-only; never throws.
function parseItinerary(text: string): any | null {
  const closed = text.match(/<itinerary>([\s\S]*?)<\/itinerary>/)?.[1]
  if (closed == null) return null
  const inner = closed.trim()
  try { return JSON.parse(inner) } catch {
    const m = inner.match(/\{[\s\S]*\}/)
    if (m) { try { return JSON.parse(m[0]) } catch { return null } }
    return null
  }
}

// Walk messages newest-first; return the LAST assistant <itinerary> that parses.
function lastEmittedItinerary(messages: unknown): any | null {
  const arr = Array.isArray(messages) ? (messages as Msg[]) : []
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i]
    if (m?.role === 'assistant' && typeof m.content === 'string') {
      const itin = parseItinerary(m.content)
      if (itin && Array.isArray(itin.stops)) return itin
    }
  }
  return null
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const fmtDate = (iso: string) => { try { return new Date(iso).toLocaleString() } catch { return iso } }
// Human-readable date+time, e.g. "Jun 12, 2026, 10:48 AM". 'not set' for null.
const fmtDateTime = (iso?: string | null) => {
  if (!iso) return 'not set'
  try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) }
  catch { return String(iso) }
}
// Date-only, e.g. "Sep 1, 2026". Used for the trip's intended travel date — a
// stored UTC-midnight calendar date, so route through parseTripDate (local-noon
// anchor on the UTC day) to avoid the negative-offset day-shift. fmtDate /
// fmtDateTime above format true timestamps (createdAt/updatedAt) and stay raw.
const fmtDateOnly = (iso?: string | null) => {
  if (!iso) return 'not set'
  try { return parseTripDate(iso)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) ?? 'not set' }
  catch { return String(iso) }
}
const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s)

// CONVERSATION (PlanningSession) status — explicitly labeled so it never reads
// as the trip's status. Pine (#3E5540) is reserved for booked/confirmed only,
// so a finished CONVERSATION uses neutral slate, never pine.
const convLabel = (s: string) => `Conversation: ${titleCase(s)}`
const convClass = (s: string) => {
  switch ((s || '').toUpperCase()) {
    case 'PLANNING':  return 'bg-sky-50 text-sky-700'
    case 'COMPLETED': return 'bg-slate-100 text-slate-600'
    case 'ARCHIVED':  return 'bg-amber-50 text-amber-700'
    default:          return 'bg-gray-100 text-gray-600'
  }
}
// TRIP (Trip) status — a DIFFERENT object than the conversation. Indigo family
// + inset ring keeps it visually distinct from the conversation pill. Pine stays
// reserved (no trip.status value is "booked" — booking lives per-stop).
const tripClass = (s: string) => {
  switch ((s || '').toUpperCase()) {
    case 'PLANNING':  return 'bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200'
    case 'ACTIVE':    return 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200'
    case 'COMPLETED': return 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200'
    default:          return 'bg-gray-100 text-gray-500 ring-1 ring-inset ring-gray-200'
  }
}

// A labeled, copyable identifier row (user / session / trip id, trip name).
function IdRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
      <div className="flex items-center gap-1.5">
        <code className="text-xs text-gray-800 break-all">{value}</code>
        <CopyIcon value={value} title={`Copy ${label}`} />
      </div>
    </div>
  )
}

// Session-list view filter. Most sessions are empty zero-message stubs, so the
// list defaults to "trips" and lets the admin widen to see the rest.
type SessionFilter = 'trips' | 'untitled' | 'all'

// A "trip" session built a trip (has a tripId). An "empty/untitled" session
// never built a trip AND has zero messages — the stub clutter hidden by default.
// (A no-trip session that DOES have messages is an in-progress chat — it shows
// only under "All", by design.)
const sessionMsgCount = (s: Session) => (Array.isArray(s.messages) ? s.messages.length : 0)
const isTripSession = (s: Session) => !!s.tripId
const isEmptySession = (s: Session) => !s.tripId && sessionMsgCount(s) === 0

export default function AdminSessionInspectorPage() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<InspectEnvelope | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Session-list view filter. Defaults to 'trips' (the de-cluttered view) on
  // every fresh lookup — most sessions are empty zero-message stubs.
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('trips')
  const [searchParams] = useSearchParams()

  // Shared fetch — used by both the manual search box and the deep-link entry.
  async function runParams(params: { tripId?: string; sessionId?: string; email?: string }, displayLabel?: string) {
    setLoading(true); setError(null); setData(null); setSelectedId(null); setSessionFilter('trips')
    if (displayLabel != null) setQuery(displayLabel)
    try {
      const res = await adminApi.inspectSession(params)
      const env = res.data as InspectEnvelope
      setData(env)
      // Auto-select when there's exactly one session.
      if (env.sessions?.length === 1) setSelectedId(env.sessions[0].id)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Lookup failed')
    } finally {
      setLoading(false)
    }
  }

  async function runLookup(e?: React.FormEvent) {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return
    // '@' → email lookup (case-insensitive server-side); otherwise a trip id.
    // (sessionId is deep-link-only — an admin never types a raw session id.)
    await runParams(q.includes('@') ? { email: q } : { tripId: q })
  }

  // Deep-link entry: the feedback inbox links here as ?tripId=… or ?sessionId=…
  // (the inspector resolves a sessionId to its session + any built trip). Runs
  // the lookup automatically so the admin lands straight on the result.
  useEffect(() => {
    const tripId = searchParams.get('tripId')
    const sessionId = searchParams.get('sessionId')
    if (tripId) runParams({ tripId }, tripId)
    else if (sessionId) runParams({ sessionId }, sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // ── User type-ahead ─────────────────────────────────────────────────────────
  // Reuses the admin user list (getSubscribers) — fetched ONCE, lazily, on first
  // focus — then filters client-side by name + email. No per-keystroke request;
  // the filter is debounced ~250ms purely for feel. Users only (never trips or
  // sessions). Selecting a row runs the SAME email lookup as the Look up button.
  type UserOption = { id: string; firstName: string; lastName: string; email: string }
  const [userOptions, setUserOptions] = useState<UserOption[]>([])
  const usersFetchedRef = useRef(false)
  const [showSuggest, setShowSuggest] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const searchRef = useRef<HTMLDivElement>(null)

  // Lazily load the user list the first time the admin engages the field.
  function ensureUsers() {
    if (usersFetchedRef.current) return
    usersFetchedRef.current = true
    // status:'all' so suspended users stay reachable from the type-ahead.
    adminApi.getSubscribers({ status: 'all' })
      .then(res => setUserOptions(res.data as UserOption[]))
      .catch(() => { usersFetchedRef.current = false }) // allow a retry on next focus
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250)
    return () => clearTimeout(t)
  }, [query])

  const suggestions = useMemo<UserOption[]>(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return []
    return userOptions
      .filter(u =>
        `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase().includes(q) ||
        (u.email ?? '').toLowerCase().includes(q))
      .slice(0, 8)
  }, [debouncedQuery, userOptions])

  // Reset the highlighted row whenever the visible suggestion set changes.
  useEffect(() => { setActiveIndex(-1) }, [debouncedQuery])

  const suggestOpen = showSuggest && suggestions.length > 0

  function selectUser(u: UserOption) {
    setShowSuggest(false)
    setActiveIndex(-1)
    setQuery(u.email)
    runParams({ email: u.email }, u.email)
  }

  // Up/Down/Enter nav (Enter selects the highlighted row; with none highlighted
  // it falls through to the form's normal submit). Escape closes the dropdown.
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setShowSuggest(false); return }
    if (!suggestOpen) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, suggestions.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && activeIndex >= 0) { e.preventDefault(); selectUser(suggestions[activeIndex]) }
  }

  // Close on outside click (the input + dropdown both live inside searchRef).
  useEffect(() => {
    if (!suggestOpen) return
    function onDown(ev: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(ev.target as Node)) setShowSuggest(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [suggestOpen])

  // Per-bucket counts (shown on the filter pills) + the filtered list. Computed
  // over the already-fetched sessions — no refetch, presentation only.
  const sessionCounts = useMemo(() => {
    const all = data?.sessions ?? []
    return { trips: all.filter(isTripSession).length, untitled: all.filter(isEmptySession).length, all: all.length }
  }, [data])

  const filteredSessions = useMemo(() => {
    const all = data?.sessions ?? []
    if (sessionFilter === 'trips') return all.filter(isTripSession)
    if (sessionFilter === 'untitled') return all.filter(isEmptySession)
    return all
  }, [data, sessionFilter])

  const selected = useMemo(
    () => data?.sessions.find(s => s.id === selectedId) ?? null,
    [data, selectedId],
  )

  const selectedTrip = useMemo<TripLite | null>(() => {
    if (!selected || !data) return null
    if (selected.tripId) return data.trips.find(t => t.id === selected.tripId) ?? null
    return data.trip
  }, [selected, data])

  const emitted = useMemo(() => (selected ? lastEmittedItinerary(selected.messages) : null), [selected])

  const diff = useMemo(() => {
    const persistedStops: Stop[] = selectedTrip?.stops ?? []
    const emittedStops: any[] = Array.isArray(emitted?.stops) ? emitted.stops : []
    const persistedSet = new Set(persistedStops.map(s => norm(s.locationName)))
    const emittedSet = new Set(emittedStops.map(s => norm(s.locationName)))
    return {
      emittedStops,
      persistedStops,
      missingFromDb: emittedStops.filter(s => !persistedSet.has(norm(s.locationName))),
      notEmitted: persistedStops.filter(s => !emittedSet.has(norm(s.locationName))),
    }
  }, [emitted, selectedTrip])

  const usageForSelected = useMemo(() => {
    if (!selected || !data) return []
    return data.aiUsageLogs.filter(l => l.sessionId === selected.id || (selected.tripId && l.tripId === selected.tripId))
  }, [selected, data])

  const agreedStops: any[] = Array.isArray(selected?.partialTripData?.agreedStops)
    ? selected!.partialTripData.agreedStops
    : []

  // ── "Copy for support" diagnostic blocks ────────────────────────────────────
  // Plain-text, labeled lines that paste cleanly into chat / CC. Built from
  // whatever the inspector has loaded — no extra fetch, no data-shape change.
  const userName = data?.user ? `${data.user.firstName} ${data.user.lastName}`.trim() : 'Unknown user'
  const userEmail = data?.user?.email ?? ''

  // Per-user block (results-list view): identity + a one-line-per-session index.
  function userSupportText(): string {
    if (!data) return ''
    const uid = data.sessions[0]?.userId ?? ''
    const lines: (string | null)[] = [
      `User: ${userName}${userEmail ? ` <${userEmail}>` : ''}`,
      uid ? `User ID: ${uid}` : null,
      `Sessions: ${data.sessions.length}`,
      ...data.sessions.map(s => {
        const trip = s.tripId ? data.trips.find(t => t.id === s.tripId) ?? null : null
        const tripPart = s.tripId ? `${s.tripId}${trip ? ` (${trip.name})` : ''}` : 'none'
        return `- Session ${s.id} | ${convLabel(s.status)} | Trip: ${tripPart}`
      }),
    ]
    return lines.filter(Boolean).join('\n')
  }

  // Per-session block (detail view): the full diagnostic for one session/trip.
  // FEAT-REPLAY-CASES — the session reduced to the user's turns, in the replay
  // file shape (scripts/replay-session.mjs). "Save as replay case" POSTs this
  // to /admin/replay-cases with a "what went wrong" note; the case is then run
  // with `npm run replay -- --case <name>` (no JSON file to paste any more).
  function sessionReplayDraft() {
    if (!selected) return null
    const msgs = Array.isArray(selected.messages) ? selected.messages : []
    const turns = msgs
      .filter((m: any) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim())
      .map((m: any) => ({ user: m.content.trim(), expect: {} }))
    const ptd: any = selected.partialTripData ?? {}
    const slug = (selected.title || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session'
    return {
      name: slug,
      sourceSessionId: selected.id,
      sourceUserEmail: userEmail || undefined,
      setup: {
        rigId: null,
        note: [
          ptd.origin ? `origin ${ptd.origin}` : null,
          ptd.destination ? `destination ${ptd.destination}` : null,
          ptd.requestedNights != null ? `${ptd.requestedNights} nights asked` : null,
          ptd.driveCapHours != null ? `${ptd.driveCapHours}h trip drive cap` : 'profile drive cap',
          ptd.statedRig ? `stated rig ${ptd.statedRig}` : null,
        ].filter(Boolean).join(', '),
      },
      turns,
      final: {},
    }
  }

  function sessionSupportText(): string {
    if (!selected) return ''
    const lines: (string | null)[] = [
      `User: ${userName}${userEmail ? ` <${userEmail}>` : ''}`,
      selected.userId ? `User ID: ${selected.userId}` : null,
      `Session ID: ${selected.id}`,
      `Title: ${selected.title || '(untitled session)'}`,
      `Conversation status: ${titleCase(selected.status)}`,
      `Trip ID: ${selected.tripId ?? '(no trip built)'}`,
      selectedTrip ? `Trip name: ${selectedTrip.name}` : null,
      selectedTrip ? `Trip status: ${titleCase(selectedTrip.status)}` : null,
      selectedTrip ? `Travel date: ${fmtDateOnly(selectedTrip.startDate)}` : null,
      `Planning started: ${fmtDateTime(selected.createdAt)}`,
      `Last edited: ${fmtDateTime(selected.updatedAt)}`,
    ]
    return lines.filter(Boolean).join('\n')
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <Breadcrumb items={[{ label: 'Admin Dashboard' }, { label: 'Session Inspector' }]} />
      <div>
        <h1 className="text-xl font-medium text-gray-900">Session Inspector</h1>
        <p className="text-sm text-gray-500 mt-0.5">Read-only. Look up a customer's planning conversation and the trip it built.</p>
      </div>

      {/* Lookup + user type-ahead */}
      <div className="relative" ref={searchRef}>
        <form onSubmit={runLookup} className="card flex items-center gap-2">
          <Search size={16} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
          <input
            value={query}
            onChange={e => { setQuery(e.target.value); setShowSuggest(true) }}
            onFocus={() => { ensureUsers(); setShowSuggest(true) }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search by name or email, or paste a trip id"
            className="flex-1 bg-transparent text-sm outline-none text-gray-900 placeholder-gray-400"
            autoFocus
            autoComplete="off"
            role="combobox"
            aria-expanded={suggestOpen}
            aria-autocomplete="list"
          />
          <button type="submit" disabled={loading || !query.trim()} className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50">
            {loading ? 'Looking up…' : 'Look up'}
          </button>
        </form>

        {/* User suggestions — name + email match. Users only (never trips or
            sessions). onMouseDown (not onClick) so the pick lands before the
            outside-click handler can close the dropdown on blur. */}
        {suggestOpen && (
          <ul
            role="listbox"
            className="absolute z-20 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto py-1"
          >
            {suggestions.map((u, i) => (
              <li key={u.id} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  onMouseDown={e => { e.preventDefault(); selectUser(u) }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`w-full text-left px-3 py-2 flex flex-col ${i === activeIndex ? 'bg-[#1F6F8B]/5' : 'hover:bg-gray-50'}`}
                >
                  <span className="text-sm text-gray-900">{`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || '(no name)'}</span>
                  <span className="text-xs text-gray-500 break-all">{u.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <div className="card border border-red-200 bg-red-50/40 flex items-start gap-2">
          <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* ── RESULTS LIST (shown until a session is selected) ─────────────── */}
      {data && !selected && (
        <>
          {/* Customer + session picker */}
          <div className="card space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <UserIcon size={15} className="text-[#1F6F8B] flex-shrink-0" aria-hidden="true" />
                <span className="text-sm font-medium text-gray-900">
                  {data.user ? `${data.user.firstName} ${data.user.lastName}` : 'Unknown user'}
                </span>
                {data.user && (
                  <span className="text-xs text-gray-500 inline-flex items-center gap-1 min-w-0">
                    <span className="truncate">{data.user.email}</span>
                    <CopyIcon value={data.user.email} title="Copy email" />
                  </span>
                )}
              </div>
              <CopyForSupport text={userSupportText()} />
            </div>
            {data.sessions.length === 0 ? (
              <p className="text-sm text-gray-500">No planning sessions found.</p>
            ) : (
              <div className="space-y-2">
                {/* View filter — de-clutter the empty zero-message stubs without
                    deleting them. Counts come from the loaded sessions (no refetch);
                    'All' keeps the full chronological, interleaved history. */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs text-gray-500">Select a session:</p>
                  <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                    {([
                      ['trips', 'Trips', sessionCounts.trips],
                      ['untitled', 'Untitled', sessionCounts.untitled],
                      ['all', 'All', sessionCounts.all],
                    ] as [SessionFilter, string, number][]).map(([key, label, n]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSessionFilter(key)}
                        className={`px-3 py-1.5 transition-colors ${sessionFilter === key ? 'bg-[#1F6F8B] text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                      >
                        {label} <span className={sessionFilter === key ? 'text-white/80' : 'text-gray-400'}>{n}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {filteredSessions.length === 0 ? (
                  <p className="text-sm text-gray-400">No sessions in this view.</p>
                ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                        <th className="px-2 py-1 font-medium">Title</th>
                        <th className="px-2 py-1 font-medium">Msgs</th>
                        <th className="px-2 py-1 font-medium">Trip built?</th>
                        <th className="px-2 py-1 font-medium">Conversation status</th>
                        <th className="px-2 py-1 font-medium">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSessions.map(s => {
                        const count = Array.isArray(s.messages) ? s.messages.length : 0
                        const isSel = s.id === selectedId
                        const trip = s.tripId ? data.trips.find(t => t.id === s.tripId) ?? null : null
                        return (
                          <tr
                            key={s.id}
                            onClick={() => setSelectedId(s.id)}
                            className={`cursor-pointer border-b border-gray-50 last:border-0 ${isSel ? 'bg-[#1F6F8B]/5' : 'hover:bg-gray-50'}`}
                          >
                            <td className="px-2 py-2 font-medium text-gray-900 max-w-[14rem] truncate">{s.title || '(untitled session)'}</td>
                            <td className="px-2 py-2 text-gray-500">{count}</td>
                            <td className="px-2 py-2">
                              {/* Two SEPARATE facts about the trip object live here:
                                  whether a trip was built, and (if so) that trip's
                                  own status — distinct from the conversation status. */}
                              <div className="flex flex-col items-start gap-1">
                                <span className={`badge text-xs ${s.tripId ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                                  {s.tripId ? 'built trip' : 'no trip'}
                                </span>
                                {trip && (
                                  <span className={`badge text-xs ${tripClass(trip.status)}`}>
                                    Trip: {titleCase(trip.status)}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-2">
                              <span className={`badge text-xs ${convClass(s.status)}`}>{convLabel(s.status)}</span>
                            </td>
                            <td className="px-2 py-2 text-xs text-gray-400 whitespace-nowrap">{fmtDate(s.createdAt)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                )}

                {/* Legend — explains every term so the two status families aren't conflated. */}
                <div className="text-[11px] text-gray-500 leading-relaxed border-t border-gray-100 pt-2 space-y-1">
                  <p className="font-medium text-gray-600">Key</p>
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className="badge bg-gray-100 text-gray-500 text-[10px]">no trip</span> this chat never built a trip
                    <span className="text-gray-300">·</span>
                    <span className="badge bg-emerald-50 text-emerald-700 text-[10px]">built trip</span> this chat produced a trip
                  </p>
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className="badge bg-sky-50 text-sky-700 text-[10px]">Conversation: Planning</span> chat still open / in progress
                    <span className="text-gray-300">·</span>
                    <span className="badge bg-slate-100 text-slate-600 text-[10px]">Conversation: Completed</span> chat finished
                    <span className="text-gray-300">·</span>
                    <span className="badge bg-amber-50 text-amber-700 text-[10px]">Conversation: Archived</span> chat abandoned
                  </p>
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className="badge bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200 text-[10px]">Trip: …</span>
                    the built trip's OWN status (e.g. Planning) — a separate fact from the conversation status above
                  </p>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── DETAIL VIEW (replaces the list once a session is selected) ────── */}
      {data && selected && (
        <div className="space-y-4">
          <button
            onClick={() => setSelectedId(null)}
            className="text-sm text-[#1F6F8B] inline-flex items-center gap-1 hover:underline"
          >
            <ChevronLeft size={15} aria-hidden="true" /> Back to results
          </button>

          {/* Conversation (main column, left) + summary panel (sticky, right) */}
          <div className="grid lg:grid-cols-[1fr_18rem] gap-4 items-start">
            {/* LEFT — Conversation */}
            <section className="space-y-2 min-w-0">
              <h2 className="text-sm font-medium text-gray-700">Conversation</h2>
              <div className="card space-y-2 max-h-[34rem] overflow-y-auto">
                {(Array.isArray(selected.messages) ? selected.messages : []).map((m, i) => (
                  <div key={i} className={`rounded p-2 text-sm ${m.role === 'assistant' ? 'bg-[#1F6F8B]/5' : m.role === 'user' ? 'bg-gray-50' : 'bg-amber-50'}`}>
                    <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">{m.role}</div>
                    <div className="whitespace-pre-wrap break-words font-mono text-xs text-gray-800">{m.content}</div>
                  </div>
                ))}
                {(!Array.isArray(selected.messages) || selected.messages.length === 0) && (
                  <p className="text-sm text-gray-400">No messages.</p>
                )}
              </div>
            </section>

            {/* RIGHT — Summary panel (sticky) */}
            <aside className="space-y-2 lg:sticky lg:top-4 self-start">
              <div className="card space-y-3">
                {/* Name/email on their own row; the two copy actions on the
                    next row — side by side they crushed the name column. */}
                <div className="space-y-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <UserIcon size={14} className="text-[#1F6F8B] flex-shrink-0" aria-hidden="true" />
                      <span className="text-sm font-medium text-gray-900">{data.user ? `${data.user.firstName} ${data.user.lastName}` : 'Unknown user'}</span>
                    </div>
                    {data.user && (
                      <div className="ml-6 flex items-center gap-1.5">
                        <p className="text-xs text-gray-500 break-all">{data.user.email}</p>
                        <CopyIcon value={data.user.email} title="Copy email" />
                      </div>
                    )}
                  </div>
                  {/* Actions are YELLOW (things you press); the case list is a
                      blue link. Both were outline before and read as disabled. */}
                  <div className="flex flex-wrap gap-1.5">
                    <CopyForSupport text={sessionSupportText()} primary />
                    <SaveReplayCaseButton draft={sessionReplayDraft()} />
                    <ReplayCasesLink />
                  </div>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">Title</p>
                  <p className="text-sm text-gray-900">{selected.title || '(untitled session)'}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className={`badge text-xs ${selected.tripId ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{selected.tripId ? 'built trip' : 'no trip'}</span>
                  <span className={`badge text-xs ${convClass(selected.status)}`}>{convLabel(selected.status)}</span>
                  {selectedTrip && <span className={`badge text-xs ${tripClass(selectedTrip.status)}`}>Trip: {titleCase(selectedTrip.status)}</span>}
                </div>
                {/* Copyable identifiers — surfaced as text so each is one-click
                    pasteable for support/CC. Same data, presentation only. */}
                <div className="border-t border-gray-100 pt-2 space-y-1.5">
                  {selected.userId && <IdRow label="User ID" value={selected.userId} />}
                  <IdRow label="Session ID" value={selected.id} />
                  {selected.tripId && <IdRow label="Trip ID" value={selected.tripId} />}
                  {selectedTrip && <IdRow label="Trip name" value={selectedTrip.name} />}
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">Messages</p>
                  <p className="text-sm text-gray-900">{Array.isArray(selected.messages) ? selected.messages.length : 0}</p>
                </div>
                <div className="border-t border-gray-100 pt-2 space-y-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-400">Planning started</p>
                    <p className="text-sm text-gray-900">{fmtDateTime(selected.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-400">Last edited</p>
                    <p className="text-sm text-gray-900">{fmtDateTime(selected.updatedAt)}</p>
                  </div>
                  {selectedTrip && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-gray-400">Travel date</p>
                      <p className="text-sm text-gray-900">{fmtDateOnly(selectedTrip.startDate)}</p>
                    </div>
                  )}
                </div>
              </div>
            </aside>
          </div>

          {/* Captured planning data (partialTripData) */}
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-gray-700">Captured planning data <span className="font-normal text-gray-400">(partialTripData)</span></h2>
            <div className="card space-y-2 text-sm">
              {selected.partialTripData?.origin && (
                <div className="flex gap-2"><span className="text-gray-500 w-28 flex-shrink-0">Origin</span><span className="text-gray-900">{String(selected.partialTripData.origin)}</span></div>
              )}
              <div className="flex gap-2 items-center">
                <span className="text-gray-500 w-28 flex-shrink-0">Stated rig</span>
                {selected.partialTripData?.statedRig
                  ? <span className="badge bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200 text-xs">{String(selected.partialTripData.statedRig)}</span>
                  : <span className="text-gray-400">none captured</span>}
              </div>
              {Array.isArray(selected.partialTripData?.agreedStops) && (
                <div className="flex gap-2"><span className="text-gray-500 w-28 flex-shrink-0">Agreed stops</span><span className="text-gray-900">{selected.partialTripData.agreedStops.length}</span></div>
              )}
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Raw partialTripData</p>
                <pre className="bg-gray-50 border border-gray-100 rounded p-2 text-[11px] text-gray-700 overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(selected.partialTripData ?? null, null, 2)}</pre>
              </div>
            </div>
          </section>

          {/* Persisted stops */}
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-gray-700">
              Persisted stops {selectedTrip ? `— ${selectedTrip.name}` : ''}
            </h2>
            {!selectedTrip ? (
              <div className="card text-sm text-gray-500">This session did not build a trip.</div>
            ) : (
              <div className="card overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="px-3 py-2">#</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Location</th><th className="px-3 py-2">Nights</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedTrip.stops.map(s => (
                      <tr key={s.order} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-1.5 text-gray-500">{s.order}</td>
                        <td className="px-3 py-1.5"><span className="badge bg-gray-100 text-gray-600 text-xs">{s.type}</span></td>
                        <td className="px-3 py-1.5 text-gray-900">{s.locationName}{s.locationState ? `, ${s.locationState}` : ''}</td>
                        <td className="px-3 py-1.5 text-gray-700">{s.nights}</td>
                      </tr>
                    ))}
                    {selectedTrip.stops.length === 0 && (
                      <tr><td colSpan={4} className="px-3 py-2 text-gray-400">No stops.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Emitted vs persisted */}
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-gray-700">Emitted vs persisted</h2>
            <div className="card space-y-3">
              {!emitted ? (
                <p className="text-sm text-gray-500">No parseable &lt;itinerary&gt; block found in the assistant messages.</p>
              ) : (
                <>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Last emitted itinerary — {diff.emittedStops.length} stop{diff.emittedStops.length === 1 ? '' : 's'}:</p>
                    <ol className="text-sm text-gray-800 list-decimal list-inside space-y-0.5">
                      {diff.emittedStops.map((s, i) => (
                        <li key={i}>{s.locationName}{s.locationState ? `, ${s.locationState}` : ''} <span className="text-gray-400">— {s.type}, {s.nights ?? 0}n</span></li>
                      ))}
                    </ol>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className={`rounded p-2 text-sm ${diff.missingFromDb.length ? 'bg-red-50 border border-red-200' : 'bg-emerald-50 border border-emerald-200'}`}>
                      <p className="text-xs font-medium mb-1">{diff.missingFromDb.length ? '⚠ Emitted but NOT persisted (data loss)' : '✓ All emitted stops persisted'}</p>
                      {diff.missingFromDb.map((s, i) => <div key={i} className="text-red-700">{s.locationName}{s.locationState ? `, ${s.locationState}` : ''}</div>)}
                    </div>
                    <div className="rounded p-2 text-sm bg-gray-50 border border-gray-200">
                      <p className="text-xs font-medium mb-1 text-gray-600">{diff.notEmitted.length ? 'Persisted but not in last emit (e.g. transit-expander)' : 'No persisted-only stops'}</p>
                      {diff.notEmitted.map((s, i) => <div key={i} className="text-gray-700">{s.locationName}{s.locationState ? `, ${s.locationState}` : ''}</div>)}
                    </div>
                  </div>
                </>
              )}
              <div>
                <p className="text-xs text-gray-500 mb-1">partialTripData.agreedStops (ground-truth cross-check) — {agreedStops.length}:</p>
                {agreedStops.length === 0 ? (
                  <p className="text-sm text-gray-400">none stored</p>
                ) : (
                  <ol className="text-sm text-gray-700 list-decimal list-inside space-y-0.5">
                    {agreedStops.map((s, i) => (
                      <li key={i}>{s.name}{s.state ? `, ${s.state}` : ''} <span className="text-gray-400">— {s.type}, {s.nights ?? 0}n</span></li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </section>

          {/* AI usage */}
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-gray-700">AI usage</h2>
            <div className="card overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                    <th className="px-3 py-2">When</th><th className="px-3 py-2">Call</th><th className="px-3 py-2">Model</th>
                    <th className="px-3 py-2">In</th><th className="px-3 py-2">Out</th><th className="px-3 py-2">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usageForSelected.map((l, i) => {
                    const nearCap = l.callType === 'CHAT' && l.outputTokens >= CHAT_NEAR_CAP
                    return (
                      <tr key={i} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{fmtDate(l.createdAt)}</td>
                        <td className="px-3 py-1.5"><span className="badge bg-gray-100 text-gray-600 text-xs">{l.callType}</span></td>
                        <td className="px-3 py-1.5 text-gray-700">{l.model}</td>
                        <td className="px-3 py-1.5 text-gray-700">{l.inputTokens.toLocaleString()}</td>
                        <td className={`px-3 py-1.5 ${nearCap ? 'text-red-600 font-medium' : 'text-gray-700'}`}>
                          {l.outputTokens.toLocaleString()}{nearCap ? ' ⚠' : ''}
                        </td>
                        <td className="px-3 py-1.5 text-gray-700">${Number(l.estimatedCostUsd).toFixed(4)}</td>
                      </tr>
                    )
                  })}
                  {usageForSelected.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-2 text-gray-400">No usage rows for this session.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-400">
              ⚠ flags a CHAT call within {CHAT_CAP - CHAT_NEAR_CAP} tokens of the {CHAT_CAP.toLocaleString()} output cap — possible truncation.
              stop_reason is not stored, so this is a heuristic, not a confirmation.
            </p>
          </section>
        </div>
      )}
    </div>
  )
}

// FEAT-REPLAY-CASES — "Save as replay case". Opens a small inline form asking
// for a case name (prefilled slug) and "What went wrong?", POSTs the draft, and
// shows a link to the Replay Cases page + the command to run it. Disabled when
// the session has no user turns (nothing to replay).
function SaveReplayCaseButton({ draft }: { draft: any }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ name: string } | null>(null)
  const turns = draft?.turns?.length ?? 0

  useEffect(() => {
    // New session selected → reset the form (keep it closed).
    setOpen(false); setSaved(null); setError(null); setNote('')
    setName(draft?.name ?? '')
  }, [draft?.sourceSessionId])

  if (!draft) return null

  async function save() {
    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!cleanName) { setError('Give the case a name.'); return }
    if (!note.trim()) { setError('Say what went wrong — that is the whole point of the case.'); return }
    setSaving(true); setError(null)
    try {
      const res = await adminApi.createReplayCase({ ...draft, name: cleanName, note: note.trim() })
      setSaved({ name: res.data?.name ?? cleanName })
      setOpen(false)
    } catch (e: any) {
      setError(e?.response?.data?.issues?.[0]?.message ?? e?.response?.data?.error ?? 'Could not save the case.')
    } finally { setSaving(false) }
  }

  if (saved) {
    return (
      <div className="w-full text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-2.5 py-2 space-y-1">
        <p className="font-medium">Saved as replay case <code>{saved.name}</code>.</p>
        <p className="text-gray-600">Run it: <code>npm run replay -- --case {saved.name}</code></p>
        <Link to="/admin/replay-cases" className="text-[#1F6F8B] hover:underline">Open Replay Cases →</Link>
      </div>
    )
  }

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={turns === 0}
        title={turns === 0 ? 'No user turns to replay' : 'Save this conversation as a replay case'}
        className="btn-primary text-xs flex items-center gap-1.5 flex-shrink-0 disabled:opacity-50"
      >
        <Bookmark size={13} /> Save as replay case
      </button>
      {open && (
        <div className="mt-2 space-y-2 border border-gray-200 rounded-lg p-2.5 bg-gray-50">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-gray-400">Case name</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="input text-sm w-full mt-0.5"
              placeholder="del-rio-nights"
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-gray-400">What went wrong?</span>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={3}
              className="input text-sm w-full mt-0.5"
              placeholder="What the planner did, and what it should have done."
            />
          </label>
          <p className="text-[11px] text-gray-500">{turns} user turn{turns === 1 ? '' : 's'} will be saved. Add <code>expect</code> checks later on the Replay Cases page.</p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-1.5">
            <button type="button" onClick={save} disabled={saving} className="btn-primary text-xs">{saving ? 'Saving…' : 'Save case'}</button>
            <button type="button" onClick={() => { setOpen(false); setError(null) }} className="btn-ghost text-xs">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// Link to the saved cases with a live count of OPEN ones — so the list is one
// click from the place cases are created. Count is best-effort (hidden on error).
function ReplayCasesLink() {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    adminApi.listReplayCases()
      .then(res => setCount(Array.isArray(res.data) ? res.data.filter((c: any) => c.status === 'OPEN').length : null))
      .catch(() => setCount(null))
  }, [])
  return (
    <Link to="/admin/replay-cases" className="btn-secondary text-xs flex items-center gap-1.5 flex-shrink-0">
      <Repeat size={13} /> Replay cases{count != null ? ` (${count} open)` : ''}
    </Link>
  )
}
