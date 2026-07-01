import { useState } from 'react'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { Stethoscope, Play, AlertTriangle } from 'lucide-react'
import { adminApi } from '../../services/api'
import { CopyForSupport } from '../../components/admin/Copy'

// The fixed menu of canned read-only queries. There is NO free-text SQL input
// anywhere — the page only ever sends a query KEY + pasted-in id/email.
type QueryKey = 'trip_by_id' | 'user_overview' | 'orphan_check' | 'dangling_sessions' | 'user_party'

const QUERIES: { key: QueryKey; label: string; needs: 'tripId' | 'userOrEmail' | 'none'; help: string }[] = [
  { key: 'trip_by_id', label: 'Trip by ID', needs: 'tripId',
    help: 'Full state of one trip: name, status, owner email, stop count, timestamps.' },
  { key: 'user_overview', label: 'User overview (by user ID or email)', needs: 'userOrEmail',
    help: "A user's trips (with stop counts + status) and planning sessions (with tripId + status)." },
  { key: 'orphan_check', label: 'Orphan / empty-shell check (by trip ID)', needs: 'tripId',
    help: 'Does the trip row exist, who owns it, and does it have zero stops (empty shell)?' },
  { key: 'dangling_sessions', label: 'Dangling-session integrity scan', needs: 'none',
    help: 'Sessions whose tripId points to a missing Trip row. Should be empty (FK is SetNull).' },
  { key: 'user_party', label: 'User party snapshot (by user ID or email)', needs: 'userOrEmail',
    help: "Legacy travelProfile counts (adults/children/hasPets — the source of the planning chip) next to the user's DEFAULT travel party (people traveling, adults/teens, pets). Use to spot party-vs-profile drift." },
]

export default function AdminDiagnosticsPage() {
  const [queryKey, setQueryKey] = useState<QueryKey>('trip_by_id')
  const [param, setParam] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<any>(null)

  const current = QUERIES.find(q => q.key === queryKey)!

  async function run(e?: React.FormEvent) {
    e?.preventDefault()
    setError(null); setResult(null)
    const params: { query: string; tripId?: string; userId?: string; email?: string } = { query: queryKey }
    if (current.needs === 'tripId') {
      if (!param.trim()) { setError('Enter a trip ID.'); return }
      params.tripId = param.trim()
    } else if (current.needs === 'userOrEmail') {
      const v = param.trim()
      if (!v) { setError('Enter a user ID or email.'); return }
      // '@' → email; otherwise treat as a user id (matches the inspector convention).
      if (v.includes('@')) params.email = v
      else params.userId = v
    }
    setLoading(true)
    try {
      const res = await adminApi.diagnostics(params)
      setResult(res.data)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Diagnostic failed')
    } finally {
      setLoading(false)
    }
  }

  // The pasteable, copy-for-Claude block: the query key + the raw result rows.
  const resultText = result ? JSON.stringify(result, null, 2) : ''

  return (
    <div className="space-y-4 max-w-3xl">
      <Breadcrumb items={[{ label: 'Admin', href: '/admin' }, { label: 'Diagnostics' }]} />
      <div>
        <h1 className="text-xl font-medium text-gray-900 flex items-center gap-2">
          <Stethoscope size={18} className="text-[#1F6F8B]" aria-hidden="true" /> Diagnostics
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Read-only. Runs a fixed menu of SELECT-only queries through a dedicated read-only database role.
        </p>
      </div>

      <form onSubmit={run} className="card space-y-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">Query</label>
          <select
            value={queryKey}
            onChange={e => { setQueryKey(e.target.value as QueryKey); setParam(''); setResult(null); setError(null) }}
            className="input w-full"
          >
            {QUERIES.map(q => <option key={q.key} value={q.key}>{q.label}</option>)}
          </select>
          <p className="text-xs text-gray-500 mt-1">{current.help}</p>
        </div>

        {current.needs !== 'none' && (
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              {current.needs === 'tripId' ? 'Trip ID' : 'User ID or email'}
            </label>
            <input
              value={param}
              onChange={e => setParam(e.target.value)}
              placeholder={current.needs === 'tripId' ? 'cmq…' : 'cmq… or name@example.com'}
              className="input w-full font-mono text-sm"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        <button type="submit" disabled={loading} className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50">
          <Play size={14} aria-hidden="true" /> {loading ? 'Running…' : 'Run'}
        </button>
      </form>

      {error && (
        <div className="card border border-red-200 bg-red-50/40 flex items-start gap-2">
          <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {result && (
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-700">Result</h2>
            <CopyForSupport text={resultText} />
          </div>
          <pre className="bg-gray-50 border border-gray-100 rounded p-2 text-[11px] text-gray-800 overflow-x-auto whitespace-pre-wrap break-words">{resultText}</pre>
        </div>
      )}
    </div>
  )
}
