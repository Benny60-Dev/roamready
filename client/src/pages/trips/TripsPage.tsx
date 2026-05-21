import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { tripsApi } from '../../services/api'
import { Trip } from '../../types'
import TripCard from '../../components/trip/TripCard'

export default function TripsPage() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<string>('ALL')

  useEffect(() => {
    tripsApi.getAll().then(res => { setTrips(res.data); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  const filtered = trips.filter(t => {
    const matchSearch = t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.startLocation.toLowerCase().includes(search.toLowerCase())
    const matchFilter = filter === 'ALL' || t.status === filter
    return matchSearch && matchFilter
  })

  // Signature reshaped to (id) for the shared TripCard's onDelete callback.
  // The card calls e.preventDefault()/stopPropagation() internally to stop
  // the outer <Link> from navigating, so the previous (id, e) shape isn't
  // needed at this layer anymore. Behavior is otherwise unchanged — still
  // window.confirm() then tripsApi.delete + local filter; the ConfirmModal
  // swap is deferred to Sub-commit B when TripsPage is retired.
  async function deleteTrip(id: string) {
    if (!confirm('Delete this trip?')) return
    await tripsApi.delete(id)
    setTrips(trips.filter(t => t.id !== id))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-gray-900">Trips</h1>
        <Link to="/sessions/new" className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={15} /> New trip
        </Link>
      </div>

      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            className="input pl-8"
            placeholder="Search trips..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1">
          {['ALL', 'PLANNING', 'ACTIVE', 'COMPLETED', 'DRAFT'].map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === s ? 'bg-[#1F6F8B] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
              style={{ borderWidth: '0.5px' }}
            >
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="card h-20 animate-pulse bg-gray-50" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-16">
          <div className="text-4xl mb-3">🗺️</div>
          <p className="font-medium text-gray-700 mb-1">No trips found</p>
          {trips.length === 0 ? (
            <>
              <p className="text-sm text-gray-500 mb-4">Start planning your first trip</p>
              <Link to="/sessions/new" className="btn-primary inline-flex items-center gap-2">
                <Plus size={15} /> Plan a trip
              </Link>
            </>
          ) : (
            <p className="text-sm text-gray-500">Try adjusting your search or filter</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(trip => (
            <TripCard
              key={trip.id}
              trip={trip}
              variant="row"
              dateFormat="MMM d, yyyy"
              onDelete={deleteTrip}
            />
          ))}
        </div>
      )}
    </div>
  )
}
