import { useEffect, useMemo, useState } from 'react'
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
}

type SortKey = 'name' | 'email' | 'tier' | 'joined' | 'renews'
type TierFilter = 'all' | 'PRO' | 'FREE'

const fullName = (u: User) => `${u.firstName} ${u.lastName}`.trim()
const fmtDate = (d: string | null) => (d ? format(new Date(d), 'MMM d, yyyy') : '—')

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
  const [sortKey, setSortKey] = useState<SortKey>('joined')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  useEffect(() => {
    adminApi.getSubscribers().then(res => { setUsers(res.data); setLoading(false) })
  }, [])

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
    const header = ['Name', 'Email', 'Tier', 'Joined', 'Renews']
    const lines = visible.map(u => [
      fullName(u),
      u.email,
      u.subscriptionTier,
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

  const caret = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')
  const th = 'text-left text-xs font-medium text-gray-500 px-3 py-2 cursor-pointer select-none whitespace-nowrap hover:text-gray-700'

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
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                {(['all', 'PRO', 'FREE'] as TierFilter[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setTier(t)}
                    className={`px-3 py-1.5 transition-colors ${tier === t ? 'bg-[#1F6F8B] text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                  >
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
                </tr>
              </thead>
              <tbody>
                {visible.map(u => (
                  <tr key={u.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">{fullName(u)}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{u.email}</td>
                    <td className="px-3 py-2">
                      <span className={`badge text-xs ${u.subscriptionTier === 'PRO' ? 'badge-green' : 'bg-gray-100 text-gray-500'}`}>
                        {u.subscriptionTier}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(u.createdAt)}</td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(u.subscriptionEndsAt)}</td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-gray-400">No users match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
