import { useEffect, useState } from 'react'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { DollarSign, TrendingUp } from 'lucide-react'
import { adminApi } from '../../services/api'

export default function AdminRevenuePage() {
  const [revenue, setRevenue] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminApi.getRevenue().then(res => { setRevenue(res.data); setLoading(false) })
  }, [])

  return (
    <div className="space-y-4 max-w-2xl">
      <Breadcrumb items={[
        { label: 'Admin', href: '/admin' },
        { label: 'Revenue' },
      ]} />
      <h1 className="text-xl font-medium text-gray-900">Revenue</h1>
      {loading ? (
        <div className="space-y-2">{[1, 2].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-50" />)}</div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="card">
            <DollarSign size={16} className="text-[#1D9E75] mb-2" />
            <div className="text-2xl font-medium text-gray-900">${revenue?.mrr?.toFixed(2)}</div>
            <div className="text-xs text-gray-500">Monthly Recurring Revenue</div>
          </div>
          <div className="card">
            <TrendingUp size={16} className="text-[#1D9E75] mb-2" />
            <div className="text-2xl font-medium text-gray-900">${revenue?.arr?.toFixed(2)}</div>
            <div className="text-xs text-gray-500">Annual Run Rate</div>
          </div>
          <div className="card">
            <div className="text-2xl font-medium text-gray-900">{revenue?.proSubscribers}</div>
            <div className="text-xs text-gray-500">Pro subscribers</div>
          </div>
          <div className="card">
            <div className="text-2xl font-medium text-gray-900">{revenue?.proPlusSubscribers}</div>
            <div className="text-xs text-gray-500">Pro+ subscribers</div>
          </div>
        </div>
      )}
    </div>
  )
}
