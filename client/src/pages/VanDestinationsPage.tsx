import { useEffect, useState } from 'react'
import { campgroundsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'
import { useScrollResetOnReady } from '../hooks/useScrollResetOnReady'

export default function VanDestinationsPage() {
  const [destinations, setDestinations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { hasAccess } = useAuthStore()
  const { openPaywall } = useUIStore()

  useEffect(() => {
    if (!hasAccess('vanDestinations')) {
      // Empty shell behind the modal — route dismissals to /dashboard so
      // the user has a clear exit instead of a blank page. Mirrors the
      // same intent on OhvDestinationsPage.
      openPaywall('vanDestinations', { redirectOnDismiss: '/dashboard' })
      // Clear loading so the page renders an empty state behind the paywall
      // instead of an infinite spinner. setLoading(false) only fires inside
      // the .then() below, which the early-return skips.
      setLoading(false)
      return
    }
    campgroundsApi.getVan().then(res => { setDestinations(res.data); setLoading(false) })
  }, [])

  // Reset window scroll to the top on the loading→ready edge when the
  // destination list first mounts. See hooks/useScrollResetOnReady.
  useScrollResetOnReady(!loading)

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
