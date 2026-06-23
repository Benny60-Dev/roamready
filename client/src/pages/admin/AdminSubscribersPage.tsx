import { useCallback, useEffect, useMemo, useState } from 'react'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { adminApi } from '../../services/api'
import { format } from 'date-fns'

type User = {
  id: string
  firstName: string
  lastName: string
  email: string
  subscriptionTier: 'FREE' | 'PRO'
  subscriptionEndsAt: string | null
  createdAt: string
  deactivatedAt: string | null
  deactivatedReason: string | null
}

type HistoryRow = {
  id: string
  action: string
  performedBy: string
  performedByLabel: string
  reason: string | null
  metadata: unknown
  createdAt: string
}

type SortKey = 'name' | 'email' | 'tier' | 'joined' | 'renews'
type TierFilter = 'all' | 'PRO' | 'FREE'
type StatusFilter = 'active' | 'suspended' | 'all'

const fullName = (u: User) => `${u.firstName} ${u.lastName}`.trim()
const fmtDate = (d: string | null) => (d ? format(new Date(d), 'MMM d, yyyy') : '—')
const fmtDateTime = (d: string) => format(new Date(d), 'MMM d, yyyy h:mm a')
const isSuspended = (u: User) => !!u.deactivatedAt

// Quote a CSV field only when it contains a comma, quote, or newline; double
// any embedded quotes per RFC 4180.
function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export default function AdminSubscribersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [tier, setTier] = useState<TierFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [sortKey, setSortKey] = useState<SortKey>('joined')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Suspend / reactivate dialog + history modal state.
  const [suspendTarget, setSuspendTarget] = useState<User | null>(null)
  const [suspendReason, setSuspendReason] = useState('')
  const [reactivateTarget, setReactivateTarget] = useState<User | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [historyTarget, setHistoryTarget] = useState<User | null>(null)
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Server-side status filter (active/suspended/all). Refetches when it changes
  // — suspended users are only returned for 'suspended'/'all', which is what
  // makes the Reactivate button reachable.
  const fetchUsers = useCallback((s: StatusFilter) => {
    setLoading(true)
    adminApi.getSubscribers({ status: s }).then(res => { setUsers(res.data); setLoading(false) })
  }, [])

  useEffect(() => { fetchUsers(status) }, [status, fetchUsers])

  const proCount = useMemo(() => users.filter(u => u.subscriptionTier === 'PRO').length, [users])
  const freeCount = users.length - proCount

  // Clicking a header sorts by it; clicking the active header toggles direction.
  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = users.filter(u => {
      if (tier !== 'all' && u.subscriptionTier !== tier) return false
      if (!q) return true
      return fullName(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    })

    const dir = sortDir === 'asc' ? 1 : -1
    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case 'name': return fullName(a).toLowerCase().localeCompare(fullName(b).toLowerCase()) * dir
        case 'email': return a.email.toLowerCase().localeCompare(b.email.toLowerCase()) * dir
        case 'tier': return a.subscriptionTier.localeCompare(b.subscriptionTier) * dir
        case 'joined': return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir
        case 'renews': {
          // Free users (null renews) always sink to the bottom regardless of dir.
          if (!a.subscriptionEndsAt && !b.subscriptionEndsAt) return 0
          if (!a.subscriptionEndsAt) return 1
          if (!b.subscriptionEndsAt) return -1
          return (new Date(a.subscriptionEndsAt).getTime() - new Date(b.subscriptionEndsAt).getTime()) * dir
        }
      }
    })
    return rows
  }, [users, search, tier, sortKey, sortDir])

  function downloadCsv() {
    const header = ['Name', 'Email', 'Tier', 'Status', 'Joined', 'Renews']
    const lines = visible.map(u => [
      fullName(u),
      u.email,
      u.subscriptionTier,
      isSuspended(u) ? 'Suspended' : 'Active',
      fmtDate(u.createdAt),
      fmtDate(u.subscriptionEndsAt),
    ].map(csvCell).join(','))
    const csv = [header.join(','), ...lines].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `roamready-users-${format(new Date(), 'yyyy-MM-dd')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function doSuspend() {
    if (!suspendTarget || !suspendReason.trim()) return
    setActionBusy(true)
    setActionError(null)
    try {
      await adminApi.suspendUser(suspendTarget.id, suspendReason.trim())
      setSuspendTarget(null)
      setSuspendReason('')
      fetchUsers(status)
    } catch (err: any) {
      setActionError(err?.response?.data?.error || 'Failed to suspend account.')
    } finally {
      setActionBusy(false)
    }
  }

  async function doReactivate() {
    if (!reactivateTarget) return
    setActionBusy(true)
    setActionError(null)
    try {
      await adminApi.reactivateUser(reactivateTarget.id)
      setReactivateTarget(null)
      fetchUsers(status)
    } catch (err: any) {
      setActionError(err?.response?.data?.error || 'Failed to reactivate account.')
    } finally {
      setActionBusy(false)
    }
  }

  function openHistory(u: User) {
    setHistoryTarget(u)
    setHistoryRows([])
    setHistoryLoading(true)
    adminApi.getUserHistory(u.id)
      .then(res => { setHistoryRows(res.data); setHistoryLoading(false) })
      .catch(() => setHistoryLoading(false))
  }

  const caret = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')
  const th = 'text-left text-xs font-medium text-gray-500 px-3 py-2 cursor-pointer select-none whitespace-nowrap hover:text-gray-700'
  const thPlain = 'text-left text-xs font-medium text-gray-500 px-3 py-2 select-none whitespace-nowrap'
  const pill = (active: boolean) =>
    `px-3 py-1.5 transition-colors ${active ? 'bg-[#1F6F8B] text-white' : 'text-gray-600 hover:bg-gray-100'}`

  return (
    <div className="space-y-4 max-w-5xl">
      <Breadcrumb items={[
        { label: 'Admin', href: '/admin' },
        { label: 'Users' },
      ]} />
      <h1 className="text-xl font-medium text-gray-900">
        Users ({users.length}) · {proCount} Pro · {freeCount} Free
      </h1>

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="card h-14 animate-pulse bg-gray-50" />)}</div>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name or email…"
              className="input sm:max-w-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              {/* Account status (server-side) */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                {(['active', 'suspended', 'all'] as StatusFilter[]).map(s => (
                  <button key={s} onClick={() => setStatus(s)} className={pill(status === s)}>
                    {s === 'active' ? 'Active' : s === 'suspended' ? 'Suspended' : 'All'}
                  </button>
                ))}
              </div>
              {/* Tier (client-side) */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                {(['all', 'PRO', 'FREE'] as TierFilter[]).map(t => (
                  <button key={t} onClick={() => setTier(t)} className={pill(tier === t)}>
                    {t === 'all' ? 'All' : t === 'PRO' ? 'Pro' : 'Free'}
                  </button>
                ))}
              </div>
              <button onClick={downloadCsv} className="btn-ghost text-sm">Download CSV</button>
            </div>
          </div>

          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className={th} onClick={() => toggleSort('name')}>Name{caret('name')}</th>
                  <th className={th} onClick={() => toggleSort('email')}>Email{caret('email')}</th>
                  <th className={th} onClick={() => toggleSort('tier')}>Tier{caret('tier')}</th>
                  <th className={th} onClick={() => toggleSort('joined')}>Joined{caret('joined')}</th>
                  <th className={th} onClick={() => toggleSort('renews')}>Renews{caret('renews')}</th>
                  <th className={thPlain}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(u => (
                  <tr key={u.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">{fullName(u)}</span>
                        {isSuspended(u) && (
                          <span
                            className="badge text-xs bg-red-100 text-red-700"
                            title={u.deactivatedReason || 'Suspended'}
                          >
                            Suspended
                          </span>
                        )}
                      </div>
                      {isSuspended(u) && u.deactivatedReason && (
                        <div className="text-xs text-gray-400 mt-0.5 max-w-xs truncate" title={u.deactivatedReason}>
                          {u.deactivatedReason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{u.email}</td>
                    <td className="px-3 py-2">
                      <span className={`badge text-xs ${u.subscriptionTier === 'PRO' ? 'badge-green' : 'bg-gray-100 text-gray-500'}`}>
                        {u.subscriptionTier}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(u.createdAt)}</td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(u.subscriptionEndsAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {isSuspended(u) ? (
                          <button
                            onClick={() => { setActionError(null); setReactivateTarget(u) }}
                            className="text-xs px-2.5 py-1 rounded-md bg-[#1F6F8B] text-white hover:bg-[#185a72] transition-colors"
                          >
                            Reactivate
                          </button>
                        ) : (
                          <button
                            onClick={() => { setActionError(null); setSuspendReason(''); setSuspendTarget(u) }}
                            className="text-xs px-2.5 py-1 rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors"
                          >
                            Suspend
                          </button>
                        )}
                        <button onClick={() => openHistory(u)} className="btn-ghost text-xs">History</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-gray-400">No users match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Suspend dialog (required reason) ──────────────────────────────── */}
      {suspendTarget && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => { if (!actionBusy) setSuspendTarget(null) }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-lg border border-gray-200 w-full max-w-[440px] p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-semibold text-lg text-gray-900 mb-2">Suspend account</h2>
            <p className="text-sm text-gray-600 mb-4 leading-relaxed">
              Suspend <strong>{fullName(suspendTarget)}</strong> ({suspendTarget.email})? They will be unable
              to log in. This is reversible. Billing is <strong>not</strong> cancelled (cancel Stripe separately).
            </p>
            <label className="block text-xs font-medium text-gray-500 mb-1">Reason (required)</label>
            <textarea
              value={suspendReason}
              onChange={e => setSuspendReason(e.target.value)}
              rows={3}
              autoFocus
              className="input w-full"
              placeholder="Why is this account being suspended?"
            />
            {actionError && <p className="text-sm text-red-600 mt-2">{actionError}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setSuspendTarget(null)}
                disabled={actionBusy}
                className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={doSuspend}
                disabled={actionBusy || !suspendReason.trim()}
                className="bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionBusy ? 'Suspending…' : 'Suspend'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reactivate dialog (light confirm) ─────────────────────────────── */}
      {reactivateTarget && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => { if (!actionBusy) setReactivateTarget(null) }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-lg border border-gray-200 w-full max-w-[420px] p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-semibold text-lg text-gray-900 mb-2">Reactivate account</h2>
            <p className="text-sm text-gray-600 mb-4 leading-relaxed">
              Reactivate <strong>{fullName(reactivateTarget)}</strong> ({reactivateTarget.email})? They will be
              able to log in again. This does <strong>not</strong> revive a cancelled Stripe subscription — if
              billing was cancelled, they must re-subscribe.
            </p>
            {actionError && <p className="text-sm text-red-600 mb-2">{actionError}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setReactivateTarget(null)}
                disabled={actionBusy}
                className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={doReactivate}
                disabled={actionBusy}
                className="bg-[#1F6F8B] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#185a72] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionBusy ? 'Reactivating…' : 'Reactivate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Moderation history (generic over action type) ─────────────────── */}
      {historyTarget && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => setHistoryTarget(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-lg border border-gray-200 w-full max-w-[520px] max-h-[80vh] overflow-y-auto p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-semibold text-lg text-gray-900 mb-1">Moderation history</h2>
            <p className="text-sm text-gray-500 mb-4">{fullName(historyTarget)} · {historyTarget.email}</p>

            {historyLoading ? (
              <div className="space-y-2">{[1, 2].map(i => <div key={i} className="h-12 rounded animate-pulse bg-gray-50" />)}</div>
            ) : historyRows.length === 0 ? (
              <p className="text-sm text-gray-400">No moderation actions recorded for this account.</p>
            ) : (
              <ul className="space-y-3">
                {historyRows.map(h => (
                  <li key={h.id} className="border-l-2 border-gray-200 pl-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="badge text-xs bg-gray-100 text-gray-600">{h.action}</span>
                      <span className="text-xs text-gray-400">{fmtDateTime(h.createdAt)}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">by {h.performedByLabel}</div>
                    {h.reason && <div className="text-sm text-gray-700 mt-1">{h.reason}</div>}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex justify-end mt-5">
              <button onClick={() => setHistoryTarget(null)} className="btn-ghost text-sm">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
