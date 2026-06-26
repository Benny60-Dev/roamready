import { useEffect, useMemo, useState } from 'react'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { adminApi } from '../../services/api'
import { format } from 'date-fns'

// FR-MARKETING-OPTIN — read-only admin view of the opted-in marketing list
// (users with marketingConsent = true). The CAN-SPAM "who we may email" roster;
// CSV export feeds the eventual sending tool. Mirrors AdminSubscribersPage's
// shell (Breadcrumb, card table, skeleton, CSV) minus the moderation dialogs.
type MarketingSubscriber = {
  id: string
  firstName: string
  lastName: string
  email: string
  marketingConsentAt: string | null
  createdAt: string
}

const fullName = (u: MarketingSubscriber) => `${u.firstName} ${u.lastName}`.trim()
const fmtDate = (d: string | null) => (d ? format(new Date(d), 'MMM d, yyyy') : '—')

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export default function AdminMarketingSubscribersPage() {
  const [subscribers, setSubscribers] = useState<MarketingSubscriber[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    adminApi.getMarketingSubscribers()
      .then(res => { setSubscribers(res.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return subscribers
    return subscribers.filter(u => fullName(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
  }, [subscribers, search])

  function downloadCsv() {
    const header = ['Name', 'Email', 'Opted in', 'Joined']
    const lines = visible.map(u => [
      fullName(u), u.email, fmtDate(u.marketingConsentAt), fmtDate(u.createdAt),
    ].map(csvCell).join(','))
    const csv = [header.join(','), ...lines].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `roamready-marketing-subscribers-${format(new Date(), 'yyyy-MM-dd')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const th = 'text-left text-xs font-medium text-gray-500 px-3 py-2 select-none whitespace-nowrap'

  return (
    <div className="space-y-4 max-w-4xl">
      <Breadcrumb items={[
        { label: 'Admin', href: '/admin' },
        { label: 'Marketing subscribers' },
      ]} />
      <h1 className="text-xl font-medium text-gray-900">
        Marketing subscribers ({subscribers.length})
      </h1>
      <p className="text-sm text-gray-500">
        Users who explicitly opted in to marketing emails. This is the consent basis for any promotional send.
      </p>

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
            <button onClick={downloadCsv} className="btn-ghost text-sm">Download CSV</button>
          </div>

          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className={th}>Name</th>
                  <th className={th}>Email</th>
                  <th className={th}>Opted in</th>
                  <th className={th}>Joined</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(u => (
                  <tr key={u.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-3 py-2 whitespace-nowrap font-medium text-gray-900">{fullName(u)}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{u.email}</td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(u.marketingConsentAt)}</td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(u.createdAt)}</td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-400">No opted-in subscribers yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
