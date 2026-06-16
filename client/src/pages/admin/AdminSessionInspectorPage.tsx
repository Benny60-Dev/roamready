import { useMemo, useState } from 'react'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { Search, AlertTriangle, User as UserIcon } from 'lucide-react'
import { adminApi } from '../../services/api'

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
interface TripLite { id: string; name: string; stops: Stop[] }
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

export default function AdminSessionInspectorPage() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<InspectEnvelope | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  async function runLookup(e?: React.FormEvent) {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return
    setLoading(true); setError(null); setData(null); setSelectedId(null)
    // '@' → email lookup (case-insensitive server-side); otherwise a trip id.
    const params = q.includes('@') ? { email: q } : { tripId: q }
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

  return (
    <div className="space-y-6 max-w-4xl">
      <Breadcrumb items={[{ label: 'Admin Dashboard' }, { label: 'Session Inspector' }]} />
      <div>
        <h1 className="text-xl font-medium text-gray-900">Session Inspector</h1>
        <p className="text-sm text-gray-500 mt-0.5">Read-only. Look up a customer's planning conversation and the trip it built.</p>
      </div>

      {/* Lookup */}
      <form onSubmit={runLookup} className="card flex items-center gap-2">
        <Search size={16} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Trip id or customer email"
          className="flex-1 bg-transparent text-sm outline-none text-gray-900 placeholder-gray-400"
          autoFocus
        />
        <button type="submit" disabled={loading || !query.trim()} className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50">
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      {error && (
        <div className="card border border-red-200 bg-red-50/40 flex items-start gap-2">
          <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {data && (
        <>
          {/* Customer + session picker */}
          <div className="card space-y-3">
            <div className="flex items-center gap-2">
              <UserIcon size={15} className="text-[#1F6F8B]" aria-hidden="true" />
              <span className="text-sm font-medium text-gray-900">
                {data.user ? `${data.user.firstName} ${data.user.lastName}` : 'Unknown user'}
              </span>
              {data.user && <span className="text-xs text-gray-500">{data.user.email}</span>}
            </div>
            {data.sessions.length === 0 ? (
              <p className="text-sm text-gray-500">No planning sessions found.</p>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-gray-500">{data.sessions.length} session{data.sessions.length === 1 ? '' : 's'} — select one:</p>
                <div className="space-y-1">
                  {data.sessions.map(s => {
                    const count = Array.isArray(s.messages) ? s.messages.length : 0
                    const isSel = s.id === selectedId
                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelectedId(s.id)}
                        className={`w-full text-left px-3 py-2 rounded border text-sm flex items-center justify-between gap-2 ${isSel ? 'border-[#1F6F8B] bg-[#1F6F8B]/5' : 'border-gray-200 hover:border-gray-300'}`}
                      >
                        <span className="min-w-0 truncate">
                          <span className="font-medium text-gray-900">{s.title || '(untitled session)'}</span>
                          <span className="text-gray-400"> · {count} msg{count === 1 ? '' : 's'}</span>
                        </span>
                        <span className="flex items-center gap-2 flex-shrink-0">
                          <span className={`badge text-xs ${s.tripId ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                            {s.tripId ? 'built trip' : 'no trip'}
                          </span>
                          <span className="badge bg-gray-100 text-gray-600 text-xs">{s.status}</span>
                          <span className="text-xs text-gray-400">{fmtDate(s.createdAt)}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {selected && (
            <>
              {/* (a) CONVERSATION */}
              <section className="space-y-2">
                <h2 className="text-sm font-medium text-gray-700">Conversation</h2>
                <div className="card space-y-2 max-h-[28rem] overflow-y-auto">
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

              {/* (b) PERSISTED STOPS */}
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

              {/* (c) EMITTED vs PERSISTED */}
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

              {/* (d) AI USAGE */}
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
            </>
          )}
        </>
      )}
    </div>
  )
}
