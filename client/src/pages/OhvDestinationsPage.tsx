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

  // Latent same-shape bug as SessionPage's chip: /users/me returns rigs
  // without an orderBy, so user.rigs[0] is heap-ordered and unstable.
  // Pick the actual default so the OHV gate (isToyHauler check below)
  // and the displayed toys list both reflect the rig the user travels
  // with, not whichever row Postgres happened to return first.
  const rig = user?.rigs?.find(r => r.isDefault) ?? user?.rigs?.[0]

  useEffect(() => {
    if (!hasAccess('ohvDestinations')) {
      // This page renders an empty shell behind the modal (no API call fires
      // for FREE users). redirectOnDismiss sends dismissals to /dashboard so
      // closing the modal doesn't leave the user staring at a blank header
      // and an empty grid.
      openPaywall('ohvDestinations', { redirectOnDismiss: '/dashboard' })
      // Clear loading so the page renders an empty state behind the paywall
      // instead of an infinite spinner. setLoading(false) only fires inside
      // the .then() below, which the early-return skips.
      setLoading(false)
      return
    }
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
