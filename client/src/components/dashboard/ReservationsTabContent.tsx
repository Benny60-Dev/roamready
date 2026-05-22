import { Link } from 'react-router-dom'
import { Tent, DollarSign, Clock, type LucideIcon } from 'lucide-react'
import { Trip, Stop, BookingStatus } from '../../types'
import { formatTripDate } from '../../utils/dates'

/**
 * Reservations tab content — fresh per-stop roll-up across all trips.
 *
 * Block 5 supersedes the old standalone ReservationsPage (which rendered
 * per-trip aggregate cards). The unit of display is now the individual stop:
 * each booked or pending campground stay across all trips becomes one row,
 * grouped Upcoming vs Past by its own arrivalDate.
 *
 * Data source is the same tripsApi.getAll() the Dashboard already fetches —
 * the server's getTrips controller includes the full ordered stops[] per
 * trip (verified Block 3 follow-up), so the roll-up is pure client compute.
 * No new endpoint, no extra request.
 */

interface Props {
  trips: Trip[]
}

interface RowData {
  stop: Stop
  tripId: string
  tripName: string
}

// Statuses that count as "a reservation worth showing":
//   CONFIRMED  — actually booked
//   PENDING    — request submitted, awaiting confirmation
//   WAITLISTED — on a waitlist, not yet a hard booking
// NOT_BOOKED isn't a reservation (it's an unbooked stop in a plan).
// CANCELLED is intentionally hidden — once cancelled it's not actionable
// from this surface; the per-trip booking page is where it'd resurface.
const RESERVATION_STATUSES: BookingStatus[] = ['CONFIRMED', 'PENDING', 'WAITLISTED']

export default function ReservationsTabContent({ trips }: Props) {
  // Flatten every trip's stops, attach the parent trip's id + name to each
  // row so the drill-down link and the sub-line have what they need.
  const rows: RowData[] = trips.flatMap(t =>
    (t.stops || [])
      .filter(s => s.type !== 'HOME' && RESERVATION_STATUSES.includes(s.bookingStatus))
      .map(s => ({ stop: s, tripId: t.id, tripName: t.name }))
  )

  if (rows.length === 0) {
    return (
      <div className="card text-center py-12">
        <p className="text-sm text-gray-500">
          No reservations yet — bookings appear here once you confirm a campground.
        </p>
      </div>
    )
  }

  // ── Summary stats. Matches the calculation pattern the old ReservationsPage
  //    used: per-stop nights summed for confirmed-only; per-stop cost is
  //    siteRate × nights (the server doesn't store a single line-item total,
  //    it's derived).
  const confirmedRows = rows.filter(r => r.stop.bookingStatus === 'CONFIRMED')
  const pendingCount  = rows.length - confirmedRows.length // PENDING + WAITLISTED
  const nightsBooked  = confirmedRows.reduce((sum, r) => sum + (r.stop.nights || 0), 0)
  const campSpend     = confirmedRows.reduce(
    (sum, r) => sum + (r.stop.siteRate || 0) * (r.stop.nights || 0),
    0
  )

  // ── Upcoming / Past split. Past = arrivalDate strictly before today.
  //    Missing arrivalDate falls into Upcoming (matches the old page's
  //    behavior — an undated trip with a confirmed stop reads as future,
  //    not historical).
  const now = new Date()
  function isPast(stop: Stop): boolean {
    if (!stop.arrivalDate) return false
    return new Date(stop.arrivalDate) < now
  }

  // ISO date strings sort lexically — same chronological order, no parse step.
  // Stops without arrivalDate sink to the bottom of their bucket.
  function sortByDate(a: RowData, b: RowData): number {
    const da = a.stop.arrivalDate
    const db = b.stop.arrivalDate
    if (da && db) return da.localeCompare(db)
    if (da) return -1
    if (db) return 1
    return 0
  }

  const upcoming = rows.filter(r => !isPast(r.stop)).sort(sortByDate)
  const past     = rows.filter(r =>  isPast(r.stop)).sort(sortByDate)

  return (
    <div className="space-y-5">
      {/* Summary bar — orientation, not the hero. Thin 3-tile row using the
          same card chrome as the rest of the Dashboard so it doesn't feel
          like a special surface. */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryTile
          icon={Tent}
          label="Nights booked"
          value={nightsBooked > 0 ? nightsBooked : '—'}
        />
        <SummaryTile
          icon={DollarSign}
          label="Camping spend"
          value={campSpend > 0 ? `$${campSpend.toLocaleString()}` : '—'}
        />
        <SummaryTile
          icon={Clock}
          label="Pending"
          value={pendingCount > 0 ? pendingCount : '—'}
        />
      </div>

      {/* Upcoming group */}
      {upcoming.length > 0 && (
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Upcoming
          </h2>
          <div className="space-y-2">
            {upcoming.map(row => <ReservationRow key={row.stop.id} row={row} />)}
          </div>
        </div>
      )}

      {/* Past group — same row markup, container dimmed so it reads as
          historical without losing legibility. */}
      {past.length > 0 && (
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Past
          </h2>
          <div className="space-y-2 opacity-60">
            {past.map(row => <ReservationRow key={row.stop.id} row={row} />)}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function SummaryTile({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string | number
}) {
  return (
    <div className="card text-center py-3">
      <Icon size={15} className="text-[#1F6F8B] mx-auto mb-1" />
      <div className="text-base font-semibold text-gray-900">{value}</div>
      <div className="text-[11px] text-gray-500 leading-tight">{label}</div>
    </div>
  )
}

function ReservationRow({ row }: { row: RowData }) {
  const { stop, tripId, tripName } = row
  const isConfirmed = stop.bookingStatus === 'CONFIRMED'

  // Status pill — locked badge palette per Block 3's audit:
  //   CONFIRMED                → badge-completed (pine)
  //   PENDING / WAITLISTED     → badge-planning  (gold)
  const statusClass = isConfirmed ? 'badge-completed' : 'badge-planning'
  // Label copy: "booked" reads better than "confirmed" alongside "pending"
  // and "waitlist". WAITLISTED gets its own short word so the user can tell
  // it apart from PENDING in the list.
  const statusLabel = isConfirmed
    ? 'booked'
    : stop.bookingStatus === 'WAITLISTED'
      ? 'waitlist'
      : 'pending'

  // Sub-line composition. Each segment is optional; nulls drop out before
  // the " · " join so a pending stop with no conf# shows tripName · nights
  // · awaiting confirmation #, not tripName · nights · null · null.
  const subParts: Array<string | null> = [
    tripName,
    `${stop.nights} night${stop.nights === 1 ? '' : 's'}`,
    stop.siteNumber ? `site #${stop.siteNumber}` : null,
    stop.confirmationNum
      ? `conf ${stop.confirmationNum}`
      : !isConfirmed
        ? 'awaiting confirmation #'
        : null,
  ]
  const subLine = subParts.filter((s): s is string => !!s).join(' · ')

  return (
    <Link
      to={`/trips/${tripId}/booking`}
      className="card flex items-center gap-3 hover:border-[#1F6F8B]/30 transition-all"
    >
      {/* Date chip — stacked month + day. Falls back to a dim em-dash when
          a stop hasn't been dated yet (rare but possible early in planning). */}
      <div className="flex flex-col items-center justify-center flex-shrink-0 w-12 py-1 bg-gray-50 rounded-md">
        {stop.arrivalDate ? (
          <>
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
              {formatTripDate(stop.arrivalDate, 'MMM')}
            </div>
            <div className="text-base font-semibold text-gray-900 leading-none">
              {formatTripDate(stop.arrivalDate, 'd')}
            </div>
          </>
        ) : (
          <div className="text-[10px] text-gray-400">—</div>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-gray-900 truncate">
          {stop.campgroundName || stop.locationName}
        </h3>
        <p className="text-xs text-gray-500 truncate">{subLine}</p>
      </div>

      {/* Status pill — flex-shrink-0 so it doesn't get squeezed when the
          campground name or sub-line overflows. */}
      <span className={`badge ${statusClass} text-xs capitalize flex-shrink-0`}>
        {statusLabel}
      </span>
    </Link>
  )
}
