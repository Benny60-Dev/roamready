import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Calendar, CheckCircle, Clock, Tent, MapPin, DollarSign, ChevronRight } from 'lucide-react'
import { tripsApi } from '../services/api'
import { Trip } from '../types'
import { format } from 'date-fns'

// ─── Per-trip booking stats ───────────────────────────────────────────────────

function getTripStats(trip: Trip) {
  const bookableStops = (trip.stops || []).filter(s => s.type !== 'HOME')
  const confirmed     = bookableStops.filter(s => s.bookingStatus === 'CONFIRMED')
  const pending       = bookableStops.filter(s => s.bookingStatus === 'PENDING' || s.bookingStatus === 'WAITLISTED')
  const campCost      = bookableStops.reduce((sum, s) => sum + (s.siteRate || 0) * (s.nights || 0), 0)
  const nightsBooked  = confirmed.reduce((sum, s) => sum + (s.nights || 0), 0)

  // Derive earliest arrival date from stops if trip.startDate isn't set
  const dates = bookableStops.map(s => s.arrivalDate).filter(Boolean) as string[]
  const earliestDate = trip.startDate || (dates.length ? dates.sort()[0] : undefined)

  type BookingLevel = 'all' | 'partial' | 'none'
  let bookingLevel: BookingLevel = 'none'
  if (confirmed.length === bookableStops.length && bookableStops.length > 0) bookingLevel = 'all'
  else if (confirmed.length > 0 || pending.length > 0) bookingLevel = 'partial'

  return { bookableStops, confirmed, pending, campCost, nightsBooked, earliestDate, bookingLevel }
}

// ─── Trip booking card ────────────────────────────────────────────────────────

function TripBookingCard({ trip }: { trip: Trip }) {
  const navigate = useNavigate()
  const { bookableStops, confirmed, pending, campCost, earliestDate, bookingLevel } = getTripStats(trip)

  const statusConfig = {
    all:     { label: 'All booked',        cls: 'bg-[#DCE5D5] text-[#2F4030]',  icon: <CheckCircle size={11} /> },
    partial: { label: 'Partially booked',  cls: 'bg-amber-100 text-amber-700',  icon: <Clock size={11} /> },
    none:    { label: 'Not started',       cls: 'bg-gray-100 text-gray-500',    icon: null },
  }
  const sc = statusConfig[bookingLevel]

  return (
    <div
      onClick={() => navigate(`/trips/${trip.id}/map`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          navigate(`/trips/${trip.id}/map`)
        }
      }}
      role="link"
      tabIndex={0}
      className="card hover:border-[#1F6F8B]/30 transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#1F6F8B]/40"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {/* Trip name + booking status badge */}
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-medium text-gray-900 text-sm">{trip.name}</h3>
            <span className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${sc.cls}`}>
              {sc.icon}{sc.label}
            </span>
          </div>

          {/* Route */}
          <p className="text-xs text-gray-500 truncate flex items-center gap-1">
            <MapPin size={10} className="flex-shrink-0" />
            {trip.startLocation} → {trip.endLocation}
          </p>

          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-gray-400">
            {earliestDate && (
              <span className="flex items-center gap-1">
                <Calendar size={11} />
                {format(new Date(earliestDate), 'MMM d, yyyy')}
                {trip.endDate && <> → {format(new Date(trip.endDate), 'MMM d, yyyy')}</>}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Tent size={11} />
              {confirmed.length}/{bookableStops.length} stop{bookableStops.length !== 1 ? 's' : ''} booked
            </span>
            {campCost > 0 && (
              <span className="flex items-center gap-1">
                <DollarSign size={11} />
                ${campCost.toLocaleString()} camping
              </span>
            )}
            {pending.length > 0 && (
              <span className="flex items-center gap-1 text-amber-500">
                <Clock size={11} />
                {pending.length} pending
              </span>
            )}
          </div>
        </div>

        {/* CTA */}
        <Link
          to={`/trips/${trip.id}/booking`}
          onClick={(e) => e.stopPropagation()}
          className="flex-shrink-0 flex items-center gap-1 text-xs font-semibold px-3 py-2 rounded-lg bg-[#F7A829] text-white hover:bg-[#C9851A] transition-colors whitespace-nowrap"
        >
          View bookings <ChevronRight size={13} />
        </Link>
      </div>

      {/* Progress bar */}
      {bookableStops.length > 0 && (
        <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${bookingLevel === 'all' ? 'bg-[#3E5540]' : 'bg-amber-400'}`}
            style={{ width: `${(confirmed.length / bookableStops.length) * 100}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type FilterTab = 'ALL' | 'UPCOMING' | 'COMPLETED'

export default function ReservationsPage() {
  const [trips, setTrips]     = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter]   = useState<FilterTab>('ALL')

  useEffect(() => {
    tripsApi.getAll()
      .then(res => { setTrips(res.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  // Only show trips that have at least one bookable (non-HOME) stop
  const tripsWithStops = trips.filter(t => (t.stops || []).some(s => s.type !== 'HOME'))

  const now = new Date()

  function getEarliestDate(trip: Trip): Date | null {
    const { earliestDate } = getTripStats(trip)
    return earliestDate ? new Date(earliestDate) : null
  }

  // Filter
  const filtered = tripsWithStops.filter(t => {
    if (filter === 'ALL') return true
    if (filter === 'COMPLETED') return t.status === 'COMPLETED'
    // UPCOMING: not completed and (no date set, or earliest date is in the future)
    if (filter === 'UPCOMING') {
      if (t.status === 'COMPLETED') return false
      const d = getEarliestDate(t)
      return !d || d >= now
    }
    return true
  })

  // Sort: soonest first, no-date trips at bottom
  const sorted = [...filtered].sort((a, b) => {
    const da = getEarliestDate(a)
    const db = getEarliestDate(b)
    if (da && db) return da.getTime() - db.getTime()
    if (da) return -1
    if (db) return 1
    return 0
  })

  // ── Summary bar stats across ALL trips (not filtered) ────────────────────
  const allStats = tripsWithStops.map(getTripStats)
  const totalNightsBooked = allStats.reduce((sum, s) => sum + s.nightsBooked, 0)
  const totalCampSpend    = allStats.reduce((sum, s) => {
    return sum + s.confirmed.reduce((cs, stop) => cs + (stop.siteRate || 0) * (stop.nights || 0), 0)
  }, 0)
  const tripsWithPending  = allStats.filter(s => s.pending.length > 0).length

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="w-6 h-6 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="space-y-5 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Bookings</h1>

      {/* Summary bar */}
      {tripsWithStops.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: Tent,        label: 'Nights booked',    value: totalNightsBooked || '—' },
            { icon: DollarSign,  label: 'Camping spend',    value: totalCampSpend ? `$${totalCampSpend.toLocaleString()}` : '—' },
            { icon: Clock,       label: 'Trips w/ pending', value: tripsWithPending || '—' },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="card text-center py-3">
              <Icon size={15} className="text-[#1F6F8B] mx-auto mb-1" />
              <div className="text-base font-semibold text-gray-900">{value}</div>
              <div className="text-[11px] text-gray-500 leading-tight">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filter tabs */}
      {tripsWithStops.length > 0 && (
        <div className="flex gap-1">
          {(['ALL', 'UPCOMING', 'COMPLETED'] as FilterTab[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === f
                  ? 'bg-[#1F6F8B] text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
              style={{ borderWidth: '0.5px' }}
            >
              {f === 'ALL' ? 'All trips' : f === 'UPCOMING' ? 'Upcoming' : 'Completed'}
            </button>
          ))}
        </div>
      )}

      {/* Trip list */}
      {tripsWithStops.length === 0 ? (
        <div className="card text-center py-16">
          <div className="text-4xl mb-3">🏕️</div>
          <p className="font-medium text-gray-700 mb-1">No trips to book yet</p>
          <p className="text-sm text-gray-500 mb-4">Create a trip and add campground stops to start booking</p>
          <Link to="/trips/new" className="btn-primary inline-flex items-center gap-2 text-sm">
            Plan a trip
          </Link>
        </div>
      ) : sorted.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-sm text-gray-500">No {filter.toLowerCase()} trips found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map(trip => (
            <TripBookingCard key={trip.id} trip={trip} />
          ))}
        </div>
      )}
    </div>
  )
}
