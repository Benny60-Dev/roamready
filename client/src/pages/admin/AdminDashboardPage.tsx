import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { Users, DollarSign, Map, MessageSquare } from 'lucide-react'
import { adminApi } from '../../services/api'

export default function AdminDashboardPage() {
  const [metrics, setMetrics] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminApi.getMetrics().then(res => { setMetrics(res.data); setLoading(false) })
  }, [])

  const stats = metrics ? [
    { icon: Users, label: 'Total users', value: metrics.totalUsers, sub: `+${metrics.newUsersLast30Days} this month` },
    { icon: DollarSign, label: 'Pro subscribers', value: metrics.proUsers + metrics.proPlusUsers, sub: `${metrics.proUsers} Pro · ${metrics.proPlusUsers} Pro+` },
    { icon: Map, label: 'Total trips', value: metrics.totalTrips, sub: `${metrics.completedTrips} completed` },
    { icon: Users, label: 'Free users', value: metrics.freeUsers, sub: 'Convert to paid' },
  ] : []

  return (
    <div className="space-y-6 max-w-4xl">
      <Breadcrumb items={[{ label: 'Admin Dashboard' }]} />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-gray-900">Admin Dashboard</h1>
        <div className="flex gap-2">
          <Link to="/admin/feedback" className="btn-ghost text-sm flex items-center gap-1.5"><MessageSquare size={14} /> Feedback</Link>
          <Link to="/admin/revenue" className="btn-ghost text-sm flex items-center gap-1.5"><DollarSign size={14} /> Revenue</Link>
          <Link to="/admin/subscribers" className="btn-ghost text-sm flex items-center gap-1.5"><Users size={14} /> Subscribers</Link>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{[1, 2, 3, 4].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-50" />)}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {stats.map(({ icon: Icon, label, value, sub }) => (
            <div key={label} className="card">
              <div className="flex items-center gap-2 mb-2">
                <Icon size={15} className="text-[#1D9E75]" />
                <span className="text-xs text-gray-500">{label}</span>
              </div>
              <div className="text-2xl font-medium text-gray-900">{value?.toLocaleString()}</div>
              <div className="text-xs text-gray-400 mt-0.5">{sub}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
