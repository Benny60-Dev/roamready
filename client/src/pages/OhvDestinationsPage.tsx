import { useEffect, useState } from 'react'
import { campgroundsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'
import { AlertTriangle } from 'lucide-react'

export default function OhvDestinationsPage() {
  const [destinations, setDestinations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { hasAccess, user } = useAuthStore()
  const { openPaywall } = useUIStore()

  const rig = user?.rigs?.[0]

  useEffect(() => {
    if (!hasAccess('ohvDestinations')) { openPaywall('ohvDestinations'); return }
    campgroundsApi.getOhv().then(res => { setDestinations(res.data); setLoading(false) })
  }, [])

  if (!rig?.isToyHauler && rig) {
    return (
      <div className="card text-center py-12 max-w-md mx-auto mt-8">
        <AlertTriangle size={32} className="text-amber-500 mx-auto mb-3" />
        <h2 className="font-medium text-gray-900 mb-1">OHV Destinations</h2>
        <p className="text-sm text-gray-500">This section is for toy hauler users. Update your rig profile to enable OHV features.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-medium text-gray-900">OHV Destinations</h1>
        <p className="text-sm text-gray-500">Matched to your toys: {rig?.toys ? (rig.toys as string[]).join(', ') : 'Update your rig profile'}</p>
      </div>
      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-50" />)}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {destinations.map(d => (
            <div key={d.id} className="card">
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-medium text-gray-900 text-sm">{d.name}</h3>
                {d.matchScore && <span className="badge-green text-xs">{d.matchScore}% match</span>}
              </div>
              {d.season && <p className="text-xs text-gray-500 mb-1">📅 {d.season}</p>}
              <div className="flex flex-wrap gap-1 mt-2">
                {d.terrainTypes?.map((t: string) => <span key={t} className="badge bg-amber-50 text-amber-700 text-xs">{t}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
