import { useEffect, useState } from 'react'
import { campgroundsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'

export default function VanDestinationsPage() {
  const [destinations, setDestinations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { hasAccess } = useAuthStore()
  const { openPaywall } = useUIStore()

  useEffect(() => {
    if (!hasAccess('vanDestinations')) { openPaywall('vanDestinations'); return }
    campgroundsApi.getVan().then(res => { setDestinations(res.data); setLoading(false) })
  }, [])

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-medium text-gray-900">Van Life Destinations</h1>
        <p className="text-sm text-gray-500">BLM, dispersed camping, and Harvest Hosts locations</p>
      </div>
      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="card h-20 animate-pulse bg-gray-50" />)}</div>
      ) : (
        <div className="space-y-2">
          {destinations.map(d => (
            <div key={d.id} className="card">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium text-gray-900 text-sm">{d.name}</h3>
                  <span className="badge-purple text-xs mt-0.5">{d.type || 'BLM'}</span>
                </div>
                {d.stealthRating && <div className="text-xs text-gray-500">Stealth: {d.stealthRating}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
