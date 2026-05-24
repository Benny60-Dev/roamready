import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { MapPin, Calendar, DollarSign, Tent } from 'lucide-react'
import { tripsApi } from '../services/api'
import { Trip } from '../types'
import { formatTripDate } from '../utils/dates'
import { buildStopBadges, formatStopBadgeLabel, formatStopBadgeMarker, isHomeBadge } from '../utils/stopBadge'
import { computeTripTotals } from '../utils/tripTotals'

export default function SharedTripPage() {
  const { token } = useParams<{ token: string }>()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!token) return
    tripsApi.getShared(token).then(res => { setTrip(res.data); setLoading(false) }).catch(() => { setNotFound(true); setLoading(false) })
  }, [token])

  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="w-6 h-6 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin" /></div>
  if (notFound) return (
    <div className="min-h-screen flex flex-col items-center justify-center text-center p-4">
      <div className="text-4xl mb-3">🗺️</div>
      <h1 className="text-xl font-medium text-gray-900 mb-1">Trip not found</h1>
      <p className="text-gray-500 mb-4">This share link may have expired or been removed.</p>
      <Link to="/" className="btn-primary">Plan your own trip</Link>
    </div>
  )
  if (!trip) return null

  const sortedStops        = [...(trip.stops || [])].sort((a, b) => a.order - b.order)
  // No homeLocation available in public shared view — last stop always gets 'F'
  const stopDisplayNumbers = buildStopBadges(sortedStops)
  // Full cost on the share view. This page is public (token-auth) and
  // can't itself call the auth-required GET /trips/:id/fuel-estimate, but
  // it CAN read the stored trip.estimatedFuel that's persisted whenever
  // the trip's owner opens the itinerary or map page (server-side
  // side-effect write in getTripFuelEstimate). So the share viewer sees
  // the owner's last-known full total — not stale enough to matter for
  // weekly EIA pricing, and it correctly retires the misleading
  // "Est. camp" label this page used to show.
  const tripTotals = computeTripTotals(trip, { fuelEstimate: trip.estimatedFuel })
  const costTotal = tripTotals.hasAnyActuals
    ? tripTotals.actualTotal
    : tripTotals.plannedTotal

  return (
    <div className="min-h-screen bg-rr-bg">
      <header className="bg-white border-b border-gray-100 py-3 px-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <img src="/roamready-icon.png" alt="RoamReady" className="h-8 w-auto object-contain" />
            <span className="font-medium text-sm">
              <span style={{ color: '#1F6F8B' }}>Roam</span><span style={{ color: '#F7A829' }}>Ready</span><span style={{ color: '#1F6F8B' }}>.ai</span>
            </span>
          </Link>
          <Link to="/signup" className="btn-primary text-sm">Plan your own trip</Link>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-medium text-gray-900">{trip.name}</h1>
          <p className="text-gray-500">{trip.startLocation} → {trip.endLocation}</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { icon: MapPin, label: 'Miles', value: trip.totalMiles?.toLocaleString() || '–' },
            { icon: Tent, label: 'Nights', value: trip.totalNights || '–' },
            { icon: MapPin, label: 'Stops', value: sortedStops.filter(s => s.type !== 'HOME').length },
            { icon: DollarSign, label: 'Est. cost', value: costTotal > 0 ? `$${Math.round(costTotal).toLocaleString()}` : '–' },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="card text-center">
              <Icon size={15} className="text-[#1F6F8B] mx-auto mb-1" />
              <div className="font-medium text-gray-900">{value}</div>
              <div className="text-xs text-gray-500">{label}</div>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {sortedStops.map((stop, i) => {
            const badge = stopDisplayNumbers[stop.id]
            const isEndpoint = isHomeBadge(badge) || badge === 'F'
            return (
              <div key={stop.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-medium ${isHomeBadge(badge) ? 'bg-gray-400' : 'bg-[#1F6F8B]'}`}>
                    {formatStopBadgeMarker(badge)}
                  </div>
                  {i < sortedStops.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-1 min-h-6" />}
                </div>
                <div className="flex-1 pb-3">
                  <p className="font-medium text-gray-900">{stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}</p>
                  {isEndpoint
                    ? <p className="text-xs text-gray-400">{formatStopBadgeLabel(badge)}</p>
                    : stop.campgroundName && <p className="text-sm text-gray-500">{stop.campgroundName}</p>
                  }
                  {!isEndpoint && (
                    <div className="flex flex-wrap gap-3 mt-1 text-xs text-gray-400">
                      {stop.arrivalDate && <span><Calendar size={11} className="inline mr-0.5" />{formatTripDate(stop.arrivalDate, 'EEE, MMM d')}</span>}
                      <span><Tent size={11} className="inline mr-0.5" />{stop.nights} night{stop.nights !== 1 ? 's' : ''}</span>
                      {stop.hookupType && <span className="badge-green">{stop.hookupType}</span>}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="card text-center py-6">
          <p className="text-sm text-gray-500 mb-3">Like this itinerary? Plan your own trip with RoamReady.</p>
          <Link to="/signup" className="btn-primary">Try RoamReady free</Link>
        </div>
      </div>
    </div>
  )
}
