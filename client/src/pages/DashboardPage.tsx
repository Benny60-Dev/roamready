import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Map, Calendar, DollarSign, Tent, ChevronRight, Wrench, Package } from 'lucide-react'
import { tripsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { Trip } from '../types'
import { format } from 'date-fns'

function TripCard({ trip }: { trip: Trip }) {
  const statusColor = {
    PLANNING: 'badge-amber',
    ACTIVE: 'badge-green',
    COMPLETED: 'bg-gray-100 text-gray-600',
    DRAFT: 'bg-gray-100 text-gray-500',
  }[trip.status]

  return (
    <Link to={`/trips/${trip.id}/map`} className="card hover:border-[#1E3A8A]/30 transition-all block">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-medium text-gray-900 text-sm">{trip.name}</h3>
          <p className="text-xs text-gray-500 mt-0.5">{trip.startLocation} → {trip.endLocation}</p>
        </div>
        <span className={`badge ${statusColor} capitalize`}>{trip.status.toLowerCase()}</span>
      </div>
      <div className="flex items-center gap-4 text-xs text-gray-500">
        {trip.startDate && (
          <span className="flex items-center gap-1">
            <Calendar size={12} />
            {format(new Date(trip.startDate), 'MMM d')}
          </span>
        )}
        {trip.totalNights && (
          <span className="flex items-center gap-1">
            <Tent size={12} />
            {trip.totalNights}n
          </span>
        )}
        {trip.totalMiles && (
          <span className="flex items-center gap-1">
            <Map size={12} />
            {trip.totalMiles.toLocaleString()}mi
          </span>
        )}
        {(trip.estimatedFuel || trip.estimatedCamp) && (
          <span className="flex items-center gap-1">
            <DollarSign size={12} />
            ~${((trip.estimatedFuel || 0) + (trip.estimatedCamp || 0)).toLocaleString()}
          </span>
        )}
      </div>
    </Link>
  )
}

export default function DashboardPage() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)
  const { user } = useAuthStore()

  useEffect(() => {
    tripsApi.getAll().then(res => { setTrips(res.data); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  const activeTrip = trips.find(t => t.status === 'ACTIVE')
  const planningTrips = trips.filter(t => t.status === 'PLANNING')
  const completedTrips = trips.filter(t => t.status === 'COMPLETED')

  const isTrial = user?.trialEndsAt && new Date() < new Date(user.trialEndsAt)
  const trialDaysLeft = user?.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(user.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0

  return (
    <div className="space-y-6">
      {/* Trial banner */}
      {isTrial && user?.subscriptionTier === 'FREE' && (
        <div className="bg-[#EFF6FF] border border-[#1E3A8A]/20 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-[#1E40AF]">🎉 Pro trial active — {trialDaysLeft} days left</p>
            <p className="text-xs text-[#1E3A8A] mt-0.5">All Pro features unlocked. Upgrade to keep them.</p>
          </div>
          <Link to="/profile/billing/upgrade" className="btn-primary text-sm">Upgrade</Link>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium text-gray-900">Good morning, {user?.firstName}</h1>
          <p className="text-sm text-gray-500">Your trip dashboard</p>
        </div>
        <Link to="/trips/new" className="btn-primary flex items-center gap-2">
          <Plus size={16} /> New trip
        </Link>
      </div>

      {/* Active trip */}
      {activeTrip && (
        <div>
          <h2 className="text-sm font-medium text-gray-700 mb-2">Active trip</h2>
          <div className="bg-[#EFF6FF] border border-[#1E3A8A]/20 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-[#1E40AF]">{activeTrip.name}</h3>
                <p className="text-sm text-[#1E3A8A] mt-0.5">{activeTrip.startLocation} → {activeTrip.endLocation}</p>
              </div>
              <Link to={`/trips/${activeTrip.id}/map`} className="btn-primary text-sm flex items-center gap-1">
                View <ChevronRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Planning */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-gray-700">Planning</h2>
          <Link to="/trips" className="text-xs text-[#1E3A8A]">View all</Link>
        </div>
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[1, 2].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-50" />)}
          </div>
        ) : planningTrips.length === 0 ? (
          <div className="card text-center py-10">
            <div className="text-4xl mb-3">🗺️</div>
            <p className="font-medium text-gray-700 mb-1">No trips yet</p>
            <p className="text-sm text-gray-500 mb-4">Start planning your next adventure</p>
            <Link to="/trips/new" className="btn-primary inline-flex items-center gap-2">
              <Plus size={15} /> Plan a trip
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {planningTrips.map(trip => <TripCard key={trip.id} trip={trip} />)}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Quick actions</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { to: '/maintenance', icon: Wrench, label: 'Maintenance' },
            { to: '/reservations', icon: Tent, label: 'Bookings' },
            { to: '/resources', icon: Map, label: 'Resources' },
            { to: '/roadmap', icon: Package, label: 'Roadmap' },
          ].map(({ to, icon: Icon, label }) => (
            <Link key={to} to={to} className="card flex flex-col items-center gap-2 py-4 hover:border-[#1E3A8A]/30 transition-all">
              <Icon size={18} className="text-[#1E3A8A]" />
              <span className="text-xs text-gray-600">{label}</span>
            </Link>
          ))}
        </div>
      </div>

      {/* Completed */}
      {completedTrips.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-700 mb-2">Completed trips</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {completedTrips.slice(0, 4).map(trip => <TripCard key={trip.id} trip={trip} />)}
          </div>
        </div>
      )}
    </div>
  )
}
