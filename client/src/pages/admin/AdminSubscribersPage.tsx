import { useEffect, useState } from 'react'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { adminApi } from '../../services/api'
import { format } from 'date-fns'

export default function AdminSubscribersPage() {
  const [subscribers, setSubscribers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminApi.getSubscribers().then(res => { setSubscribers(res.data); setLoading(false) })
  }, [])

  return (
    <div className="space-y-4 max-w-3xl">
      <Breadcrumb items={[
        { label: 'Admin', href: '/admin' },
        { label: 'Subscribers' },
      ]} />
      <h1 className="text-xl font-medium text-gray-900">Subscribers ({subscribers.length})</h1>
      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="card h-14 animate-pulse bg-gray-50" />)}</div>
      ) : (
        <div className="card divide-y divide-gray-50">
          {subscribers.map(sub => (
            <div key={sub.id} className="flex items-center justify-between py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{sub.firstName} {sub.lastName}</p>
                <p className="text-xs text-gray-500">{sub.email}</p>
              </div>
              <div className="text-right">
                <span className={`badge text-xs ${sub.subscriptionTier === 'PRO_PLUS' ? 'badge-purple' : 'badge-green'}`}>
                  {sub.subscriptionTier}
                </span>
                {sub.subscriptionEndsAt && (
                  <p className="text-xs text-gray-400 mt-0.5">Renews {format(new Date(sub.subscriptionEndsAt), 'MMM d')}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
