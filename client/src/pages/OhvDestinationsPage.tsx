import { useEffect, useState } from 'react'
import { campgroundsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'

export default function OhvDestinationsPage() {
  const [destinations, setDestinations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { hasAccess, user } = useAuthStore()
  const { openPaywall } = useUIStore()

  // Latent same-shape bug as SessionPage's chip: /users/me returns rigs
  // without an orderBy, so user.rigs[0] is heap-ordered and unstable.
  // Pick the actual default so the "matched to your toys" personalization
  // reflects the rig the user travels with, not whichever row Postgres
  // happened to return first. (The page is no longer gated on rig type —
  // OHV is open to all PRO users; the toy-hauler lock was removed. The
  // PRO paywall in the effect below is the only access gate.)
  const rig = user?.rigs?.find(r => r.isDefault) ?? user?.rigs?.[0]

  // Personalize the header ONLY for users who actually have toys data
  // (collected solely in the toy-hauler rig form). Everyone else gets a
  // neutral framing — no toy-hauler-form nudge for users who'll never see
  // that form.
  const toys = rig?.isToyHauler && Array.isArray(rig.toys) && rig.toys.length > 0
    ? (rig.toys as string[])
    : null

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

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-medium text-gray-900">OHV Destinations</h1>
        <p className="text-sm text-gray-500">{toys ? `Matched to your toys: ${toys.join(', ')}` : 'OHV & off-road destinations'}</p>
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
