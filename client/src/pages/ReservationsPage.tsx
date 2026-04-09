import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, CheckCircle, Clock, XCircle, Tent } from 'lucide-react'
import { bookingsApi } from '../services/api'
import { format } from 'date-fns'

export default function ReservationsPage() {
  const [bookings, setBookings] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    bookingsApi.getAll().then(res => { setBookings(res.data); setLoading(false) })
  }, [])

  const upcoming = bookings.filter(b => b.arrivalDate && new Date(b.arrivalDate) >= new Date())
  const past = bookings.filter(b => !b.arrivalDate || new Date(b.arrivalDate) < new Date())

  const StatusBadge = ({ status }: { status: string }) => {
    if (status === 'CONFIRMED') return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-green-100 text-green-700 flex-shrink-0 whitespace-nowrap">
        <CheckCircle size={11} /> Booked
      </span>
    )
    if (status === 'PENDING' || status === 'WAITLISTED') return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 flex-shrink-0 whitespace-nowrap">
        <Clock size={11} /> Pending
      </span>
    )
    if (status === 'CANCELLED') return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-red-100 text-red-500 flex-shrink-0 whitespace-nowrap">
        <XCircle size={11} /> Cancelled
      </span>
    )
    return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-500 flex-shrink-0 whitespace-nowrap">
        Not booked
      </span>
    )
  }

  const BookingRow = ({ booking }: { booking: any }) => (
    <div className="card flex items-center gap-4">
      <StatusBadge status={booking.bookingStatus} />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-gray-900 truncate">{booking.locationName}</p>
        {booking.campgroundName && <p className="text-xs text-gray-500">{booking.campgroundName}</p>}
        <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
          {booking.arrivalDate && <span className="flex items-center gap-1"><Calendar size={11} />{format(new Date(booking.arrivalDate), 'MMM d, yyyy')}</span>}
          <span className="flex items-center gap-1"><Tent size={11} />{booking.nights} nights</span>
          {booking.siteRate && <span>${booking.siteRate}/night</span>}
        </div>
      </div>
      <div className="text-right">
        {booking.confirmationNum && <p className="text-xs text-gray-400">#{booking.confirmationNum}</p>}
        <Link to={`/trips/${booking.tripId}`} className="text-xs text-[#1D9E75]">View trip</Link>
      </div>
    </div>
  )

  if (loading) return <div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-[#1D9E75] border-t-transparent rounded-full animate-spin" /></div>

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Reservations</h1>

      {bookings.length === 0 ? (
        <div className="card text-center py-16">
          <div className="text-4xl mb-3">🏕️</div>
          <p className="font-medium text-gray-700 mb-1">No reservations yet</p>
          <p className="text-sm text-gray-500">Book campgrounds from your trip's booking page</p>
        </div>
      ) : (
        <>
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-gray-700 mb-2">Upcoming ({upcoming.length})</h2>
              <div className="space-y-2">
                {upcoming.map(b => <BookingRow key={b.id} booking={b} />)}
              </div>
            </div>
          )}
          {past.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-gray-700 mb-2">Past ({past.length})</h2>
              <div className="space-y-2">
                {past.map(b => <BookingRow key={b.id} booking={b} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
