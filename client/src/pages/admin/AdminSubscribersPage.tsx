import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MoreVertical, Ban, RotateCcw, Star, StarOff, Clock } from 'lucide-react'
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
  compTier: 'FREE' | 'PRO' | null
  compExpiresAt: string | null
}

type DurationKind = 'MONTH' | 'YEAR' | 'LIFETIME' | 'CUSTOM'

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
// A comp exists once compTier is set (we don't auto-clear expired comps; the
// badge surfaces the expiry so a lapsed comp is visible and revocable).
const hasComp = (u: User) => u.compTier === 'PRO'
const compBadgeLabel = (u: User) =>
  u.compExpiresAt ? `Comped · expires ${fmtDate(u.compExpiresAt)}` : 'Comped · Lifetime'

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

  // Per-row actions kebab. The menu is rendered once, fixed-positioned from the
  // trigger button's rect — the table lives in an overflow-x-auto card (which
  // also clips overflow-y), so an absolutely-positioned dropdown would be cut
  // off. menuFor holds the row; menuPos is the viewport anchor (top + right).
  const [menuFor, setMenuFor] = useState<User | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const menuRef = useRef<HTMLDivElement>(null)

  // Grant / revoke complimentary Pro.
  const [grantTarget, setGrantTarget] = useState<User | null>(null)
  const [grantDuration, setGrantDuration] = useState<DurationKind>('MONTH')
  const [grantCustomDate, setGrantCustomDate] = useState('')
  const [grantReason, setGrantReason] = useState('')
  const [revokeProTarget, setRevokeProTarget] = useState<User | null>(null)

  // Server-side status filter (active/suspended/all). Refetches when it changes
  // — suspended users are only returned for 'suspended'/'all', which is what
  // makes the Reactivate button reachable.
  const fetchUsers = useCallback((s: StatusFilter) => {
    setLoading(true)
    adminApi.getSubscribers({ status: s }).then(res => { setUsers(res.data); setLoading(false) })
  }, [])

  useEffect(() => { fetchUsers(status) }, [status, fetchUsers])

  // Open the actions menu anchored under its kebab trigger. Right-aligned to
  // the button so the panel hangs to the left and never runs off-screen.
  function openRowMenu(u: User, e: React.MouseEvent<HTMLButtonElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
    setMenuFor(u)
  }

  // Close on outside click, and on any scroll/resize (the menu is fixed and
  // doesn't track its anchor, so dismissing is simpler than repositioning).
  // Trigger buttons carry data-row-menu-trigger so their click — which toggles
  // via openRowMenu — isn't also treated as an outside dismiss. Mirrors the
  // app's existing click-away pattern (components/layout/AppLayout.tsx).
  useEffect(() => {
    if (!menuFor) return
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement
      if (menuRef.current?.contains(t)) return
      if (t.closest('[data-row-menu-trigger]')) return
      setMenuFor(null)
    }
    const onDismiss = () => setMenuFor(null)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('scroll', onDismiss, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('scroll', onDismiss, true)
    }
  }, [menuFor])

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

  // CUSTOM requires a future date; the confirm button is disabled until valid.
  const grantValid =
    !!grantReason.trim() &&
    (grantDuration !== 'CUSTOM' ||
      (!!grantCustomDate && new Date(grantCustomDate).getTime() > Date.now()))

  async function doGrantPro() {
    if (!grantTarget || !grantValid) return
    setActionBusy(true)
    setActionError(null)
    try {
      await adminApi.grantPro(grantTarget.id, {
        durationKind: grantDuration,
        // Send a full ISO datetime so the server's .datetime() validator passes.
        customExpiresAt: grantDuration === 'CUSTOM' ? new Date(grantCustomDate).toISOString() : undefined,
        reason: grantReason.trim(),
      })
      setGrantTarget(null)
      setGrantReason('')
      setGrantCustomDate('')
      setGrantDuration('MONTH')
      fetchUsers(status)
    } catch (err: any) {
      setActionError(err?.response?.data?.error || err?.response?.data?.issues?.[0]?.message || 'Failed to grant Pro.')
    } finally {
      setActionBusy(false)
    }
  }

  async function doRevokePro() {
    if (!revokeProTarget) return
    setActionBusy(true)
    setActionError(null)
    try {
      await adminApi.revokePro(revokeProTarget.id)
      setRevokeProTarget(null)
      fetchUsers(status)
    } catch (err: any) {
      setActionError(err?.response?.data?.error || 'Failed to revoke Pro.')
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
                        {hasComp(u) && (
                          <span className="badge text-xs bg-indigo-100 text-indigo-700" title="Complimentary Pro (no Stripe charge)">
                            {compBadgeLabel(u)}
                          </span>
                        )}
                      </div>
                      {isSuspended(u) && u.deactivatedReason && (
                        <div className="text-xs text-gray-400 mt-0.5 max-w-xs truncate" title={u.deactivatedReason}>
                          {u.deactivatedReason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      <div className="max-w-[220px] truncate" title={u.email}>{u.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`badge text-xs ${u.subscriptionTier === 'PRO' ? 'badge-green' : 'bg-gray-100 text-gray-500'}`}>
                        {u.subscriptionTier}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(u.createdAt)}</td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(u.subscriptionEndsAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      <button
                        data-row-menu-trigger
                        onClick={e => (menuFor?.id === u.id ? setMenuFor(null) : openRowMenu(u, e))}
                        aria-label={`Actions for ${fullName(u)}`}
                        aria-haspopup="menu"
                        aria-expanded={menuFor?.id === u.id}
                        className="p-1.5 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                      >
                        <MoreVertical size={16} />
                      </button>
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

      {/* ── Per-row actions menu (fixed, anchored under the kebab) ────────── */}
      {menuFor && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          style={{ top: menuPos.top, right: menuPos.right }}
        >
          {isSuspended(menuFor) ? (
            <button
              role="menuitem"
              onClick={() => { setActionError(null); setReactivateTarget(menuFor); setMenuFor(null) }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              <RotateCcw size={14} /> Reactivate
            </button>
          ) : (
            <button
              role="menuitem"
              onClick={() => { setActionError(null); setSuspendReason(''); setSuspendTarget(menuFor); setMenuFor(null) }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            >
              <Ban size={14} /> Suspend
            </button>
          )}
          {hasComp(menuFor) ? (
            <button
              role="menuitem"
              onClick={() => { setActionError(null); setRevokeProTarget(menuFor); setMenuFor(null) }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              <StarOff size={14} /> Revoke Pro
            </button>
          ) : (
            <button
              role="menuitem"
              onClick={() => { setActionError(null); setGrantReason(''); setGrantCustomDate(''); setGrantDuration('MONTH'); setGrantTarget(menuFor); setMenuFor(null) }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#1F6F8B] hover:bg-[#1F6F8B]/10"
            >
              <Star size={14} /> Grant Pro
            </button>
          )}
          <div className="my-1 border-t border-gray-100" />
          <button
            role="menuitem"
            onClick={() => { openHistory(menuFor); setMenuFor(null) }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            <Clock size={14} /> History
          </button>
        </div>
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

      {/* ── Grant complimentary Pro (duration + required reason) ──────────── */}
      {grantTarget && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => { if (!actionBusy) setGrantTarget(null) }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-lg border border-gray-200 w-full max-w-[440px] p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-semibold text-lg text-gray-900 mb-2">Grant complimentary Pro</h2>
            <p className="text-sm text-gray-600 mb-4 leading-relaxed">
              Give <strong>{fullName(grantTarget)}</strong> ({grantTarget.email}) Pro access with
              <strong> no Stripe charge</strong>. This is separate from paid subscriptions and is revocable.
            </p>

            <label className="block text-xs font-medium text-gray-500 mb-1">Duration</label>
            <div className="flex flex-wrap rounded-lg border border-gray-200 overflow-hidden text-sm mb-3 w-fit">
              {(['MONTH', 'YEAR', 'LIFETIME', 'CUSTOM'] as DurationKind[]).map(d => (
                <button
                  key={d}
                  onClick={() => setGrantDuration(d)}
                  className={`px-3 py-1.5 transition-colors ${grantDuration === d ? 'bg-[#1F6F8B] text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                >
                  {d === 'MONTH' ? '1 Month' : d === 'YEAR' ? '1 Year' : d === 'LIFETIME' ? 'Lifetime' : 'Custom'}
                </button>
              ))}
            </div>

            {grantDuration === 'CUSTOM' && (
              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-500 mb-1">Expires on (future date)</label>
                <input
                  type="date"
                  value={grantCustomDate}
                  min={format(new Date(Date.now() + 86400000), 'yyyy-MM-dd')}
                  onChange={e => setGrantCustomDate(e.target.value)}
                  className="input"
                />
              </div>
            )}

            <label className="block text-xs font-medium text-gray-500 mb-1">Reason (required)</label>
            <textarea
              value={grantReason}
              onChange={e => setGrantReason(e.target.value)}
              rows={2}
              className="input w-full"
              placeholder="Why is this comp being granted?"
            />
            {actionError && <p className="text-sm text-red-600 mt-2">{actionError}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setGrantTarget(null)}
                disabled={actionBusy}
                className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={doGrantPro}
                disabled={actionBusy || !grantValid}
                className="bg-[#1F6F8B] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#185a72] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionBusy ? 'Granting…' : 'Grant Pro'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Revoke complimentary Pro (light confirm) ──────────────────────── */}
      {revokeProTarget && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => { if (!actionBusy) setRevokeProTarget(null) }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-lg border border-gray-200 w-full max-w-[420px] p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-semibold text-lg text-gray-900 mb-2">Revoke complimentary Pro</h2>
            <p className="text-sm text-gray-600 mb-4 leading-relaxed">
              Remove complimentary Pro from <strong>{fullName(revokeProTarget)}</strong> ({revokeProTarget.email})?
              Any real paid subscription is unaffected.
            </p>
            {actionError && <p className="text-sm text-red-600 mb-2">{actionError}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRevokeProTarget(null)}
                disabled={actionBusy}
                className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={doRevokePro}
                disabled={actionBusy}
                className="bg-[#1F6F8B] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#185a72] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionBusy ? 'Revoking…' : 'Revoke Pro'}
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
