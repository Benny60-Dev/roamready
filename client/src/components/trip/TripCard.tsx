import { Link } from 'react-router-dom'
import { Calendar, Map, Tent, DollarSign, Trash2 } from 'lucide-react'
import { Trip } from '../../types'
import { formatTripDate, lifecycleDate, relativeTime } from '../../utils/dates'
import { computeTripTotals } from '../../utils/tripTotals'
import { deriveTripStatus } from '../../utils/tripStatus'

/**
 * Shared trip card. Replaces three previously-divergent inline copies:
 *
 *   - 'grid'    — DashboardPage's vertical grid card (default density;
 *                 used in the Dashboard's PLANNING and COMPLETED sections).
 *   - 'row'     — TripsPage's horizontal full-row list item, with an
 *                 optional Delete affordance on the right.
 *   - 'compact' — SessionPage's Continue-planning strip card on Home.
 *                 Tighter padding, no route line, no cost.
 *
 * Sub-commit A (Block 3a) introduces the component as plumbing only —
 * the three call sites are repointed at it with props chosen to reproduce
 * their prior markup byte-for-byte. `showRelative` is wired but defaults
 * off, so none of the current usages render the relativeTime stamp;
 * Sub-commit B turns it on for the merged Dashboard.
 */

export type TripCardVariant = 'grid' | 'row' | 'compact'

export interface TripCardProps {
  trip: Trip
  variant?: TripCardVariant
  /** Render the cost row (estimatedFuel + estimatedCamp). Default: true for
   *  'grid'/'row', false for 'compact'. */
  showCost?: boolean
  /** Render the "startLocation → endLocation" line. Default: true for
   *  'grid'/'row', false for 'compact'. */
  showRoute?: boolean
  /** Render relativeTime(trip.updatedAt, {short:true}) in the meta row.
   *  Default: false everywhere (Block 3b turns it on for the Dashboard). */
  showRelative?: boolean
  /** date-fns format token for trip.startDate. Default 'MMM d'. TripsPage
   *  passed 'MMM d, yyyy'. */
  dateFormat?: string
  /** When provided, the 'row' variant renders a small Delete button on
   *  the right of the card. Called with the trip id; the card wires
   *  e.preventDefault/stopPropagation internally so the outer <Link>
   *  doesn't navigate. Ignored for 'grid' and 'compact' variants —
   *  none of the current usages need delete in those layouts. */
  onDelete?: (id: string) => void
}

const STATUS_BADGE: Record<Trip['status'], string> = {
  PLANNING: 'badge-planning',
  ACTIVE: 'badge-active',
  COMPLETED: 'badge-completed',
  // Reserved — no current code path sets status to DRAFT (future "resume planning" feature)
  DRAFT: 'badge-draft',
}

export default function TripCard({
  trip,
  variant = 'grid',
  showCost,
  showRoute,
  showRelative = false,
  dateFormat = 'MMM d',
  onDelete,
}: TripCardProps) {
  const isCompact = variant === 'compact'
  const effectiveShowCost = showCost ?? !isCompact
  const effectiveShowRoute = showRoute ?? !isCompact

  // Status is derived from the trip's committed dates vs today — there's no
  // longer a stored override flag the user toggles. See utils/tripStatus.ts
  // for the rules (inclusive endpoints, no-dates → PLANNING). Both the badge
  // colour class and the lowercased label below read from this single source.
  const status = deriveTripStatus(trip)
  const statusClass = STATUS_BADGE[status]
  // Full trip cost using the stored fuel total persisted by the
  // getTripFuelEstimate side-effect: every time the owner opens the
  // itinerary or map page, trip.estimatedFuel is refreshed to the
  // current EIA-derived value, so this surface reads a real stored
  // number without firing a per-card API call.
  //
  // `cost` is the prominent primary number; `campPart` / `fuelPart` feed
  // the secondary breakdown line. fuelPart is null OR 0 on brand-new
  // trips that haven't been opened yet (estimatedFuel not yet populated)
  // — in that degraded case we hide the breakdown line entirely and the
  // primary cost equals the camp number, which is still honest (we just
  // don't claim to know fuel until the owner opens the itinerary once).
  const tt = computeTripTotals(trip, { fuelEstimate: trip.estimatedFuel })
  const cost = tt.hasAnyActuals ? tt.actualTotal : tt.plannedTotal
  const campPart = tt.hasAnyActuals ? tt.campActual : tt.campEst
  const fuelPart = tt.hasFuel
    ? (tt.hasAnyActuals ? (tt.fuelActual ?? tt.fuelEst) : tt.fuelEst)
    : null
  const hasCost = cost > 0
  const showBreakdown = hasCost && fuelPart != null && fuelPart > 0 && campPart > 0
  // Estimate-vs-actual prefix on the primary number. Only the actual side
  // drops the "~" — an estimate stays clearly flagged.
  const costPrefix = tt.hasAnyActuals ? '' : '~'

  if (variant === 'row') {
    // ── Horizontal list-row layout ─ matches TripsPage.tsx:96-131 exactly.
    return (
      <Link
        to={`/trips/${trip.id}/map`}
        className="card flex items-center justify-between hover:border-[#1F6F8B]/30 transition-all"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-gray-900 text-sm truncate">{trip.name}</h3>
            <span className={`${statusClass} text-xs`}>
              {status.toLowerCase()}
            </span>
          </div>
          {effectiveShowRoute && (
            <p className="text-xs text-gray-500 truncate">{trip.startLocation} → {trip.endLocation}</p>
          )}
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
            {trip.startDate && (
              <span className="flex items-center gap-1">
                <Calendar size={11} />
                {formatTripDate(trip.startDate, dateFormat)}
              </span>
            )}
            {trip.totalNights && (
              <span className="flex items-center gap-1 font-semibold text-gray-900">
                <Tent size={11} />
                {trip.totalNights} nights
              </span>
            )}
            {trip.totalMiles && (
              <span className="flex items-center gap-1 font-semibold text-gray-900">
                <Map size={11} />
                {trip.totalMiles.toLocaleString()} mi
              </span>
            )}
            {showRelative && trip.updatedAt && (
              <span className="flex items-center gap-1">
                {relativeTime(trip.updatedAt, { short: true })}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 ml-4">
          {effectiveShowCost && hasCost && (
            <div className="flex flex-col items-end leading-tight">
              <span className="text-sm font-semibold text-gray-900 flex items-center gap-1">
                <DollarSign size={13} />
                {costPrefix}{Math.round(cost).toLocaleString()}
              </span>
              {showBreakdown && (
                <span className="text-[10px] text-gray-400 mt-0.5">
                  ${Math.round(campPart).toLocaleString()} camp · ${Math.round(fuelPart!).toLocaleString()} fuel
                </span>
              )}
            </div>
          )}
          {onDelete && (
            <button
              onClick={e => {
                // The outer <Link> would otherwise navigate to /trips/:id/map
                // on this click — preventDefault stops the route change, and
                // stopPropagation belts-and-suspenders against any bubbling.
                e.preventDefault()
                e.stopPropagation()
                onDelete(trip.id)
              }}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors px-2 py-1"
            >
              Delete
            </button>
          )}
        </div>
      </Link>
    )
  }

  if (variant === 'compact') {
    // ── Compact vertical layout ─ matches SessionPage Continue-planning strip card.
    //    No route, no cost; tighter padding via inline style override.
    return (
      <Link
        to={`/trips/${trip.id}/map`}
        className="card hover:border-[#1F6F8B]/30 transition-all block"
        style={{ padding: 12 }}
      >
        <div className="mb-1.5">
          <span className={`badge ${statusClass} text-xs capitalize`}>
            {status.toLowerCase()}
          </span>
        </div>
        <h3 className="font-medium text-gray-900 text-sm truncate mb-1">{trip.name}</h3>
        {effectiveShowRoute && (
          <p className="text-xs text-gray-500 truncate mb-1">{trip.startLocation} → {trip.endLocation}</p>
        )}
        <div className="flex items-center gap-2.5 text-xs text-gray-500 flex-wrap">
          {trip.startDate && (
            <span className="flex items-center gap-1">
              <Calendar size={11} />
              {formatTripDate(trip.startDate, dateFormat)}
            </span>
          )}
          {trip.totalNights != null && (
            <span className="flex items-center gap-1 font-semibold text-gray-900">
              <Tent size={11} />
              {trip.totalNights}n
            </span>
          )}
          {trip.totalMiles != null && (
            <span className="flex items-center gap-1 font-semibold text-gray-900">
              <Map size={11} />
              {trip.totalMiles.toLocaleString()}mi
            </span>
          )}
          {/* Compact variant — total only, no breakdown beneath.
              The Continue-planning strip is space-constrained; the
              prominent total is the priority. Row + grid variants get
              the secondary "$X camp · $Y fuel" breakdown line. */}
          {effectiveShowCost && hasCost && (
            <span className="flex items-center gap-1 font-semibold text-gray-900">
              <DollarSign size={11} />
              {costPrefix}${Math.round(cost).toLocaleString()}
            </span>
          )}
          {showRelative && trip.updatedAt && (
            <span className="flex items-center gap-1">
              {relativeTime(trip.updatedAt, { short: true })}
            </span>
          )}
        </div>
      </Link>
    )
  }

  // ── Default 'grid' variant ─ matches DashboardPage's prior inline card,
  //    with two Block-3-followup additions:
  //      (a) a small trash icon in the top-right action cluster (only when
  //          onDelete is wired — the compact variant never gets one);
  //      (b) a secondary "N stops · M booked" meta line below the existing
  //          dates/nights/miles/cost row, gated on stops actually existing.
  const stopCount = trip.stops?.length ?? 0
  const bookedCount = trip.stops?.filter(s => s.bookingStatus === 'CONFIRMED').length ?? 0
  const showStopsLine = stopCount > 0
  // Lifecycle line ("Started <createdAt> · Edited <updatedAt rel>") reuses the
  // showRelative prop that used to gate the bare "1m ago" stamp — same opt-in
  // surface (the Dashboard grid), richer content.
  const showLifecycle = showRelative && Boolean(trip.createdAt || trip.updatedAt)

  return (
    <Link to={`/trips/${trip.id}/map`} className="card hover:border-[#1F6F8B]/30 transition-all block">
      <div className="flex items-start justify-between mb-3 gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-gray-900 text-sm truncate">{trip.name}</h3>
          {effectiveShowRoute && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">{trip.startLocation} → {trip.endLocation}</p>
          )}
        </div>
        {/* Top-right action cluster — status pill sits where it always has;
            the trash icon slots in beside it (only rendered when onDelete is
            provided). Both are flex-shrink-0 so the truncating name/route on
            the left can compress instead. */}
        <div className="flex items-start gap-2 flex-shrink-0">
          <span className={`badge ${statusClass} capitalize`}>{status.toLowerCase()}</span>
          {onDelete && (
            <button
              type="button"
              onClick={e => {
                // Outer <Link> would navigate to /trips/:id/map on this click —
                // preventDefault stops the route change; stopPropagation belts-
                // and-suspenders against any bubbling handler.
                e.preventDefault()
                e.stopPropagation()
                onDelete(trip.id)
              }}
              aria-label={`Delete ${trip.name}`}
              className="p-1 -m-1 text-gray-400 hover:text-[#B3261E] transition-colors"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs text-gray-500">
        {trip.startDate && (
          <span className="flex items-center gap-1">
            <Calendar size={12} />
            {formatTripDate(trip.startDate, dateFormat)}
          </span>
        )}
        {trip.totalNights && (
          <span className="flex items-center gap-1 font-semibold text-gray-900">
            <Tent size={12} />
            {trip.totalNights}n
          </span>
        )}
        {trip.totalMiles && (
          <span className="flex items-center gap-1 font-semibold text-gray-900">
            <Map size={12} />
            {trip.totalMiles.toLocaleString()}mi
          </span>
        )}
        {effectiveShowCost && hasCost && (
          <span className="flex items-center gap-1 font-semibold text-gray-900">
            <DollarSign size={12} />
            {costPrefix}${Math.round(cost).toLocaleString()}
          </span>
        )}
      </div>
      {/* Cost breakdown sub-line — "$X camp · $Y fuel" — only when both
          pieces are positive. Brand-new trips that haven't had their
          itinerary opened yet have estimatedFuel=null/0; the breakdown
          stays hidden so we never render "$0 fuel" or imply fuel is free.
          The primary cost (above) still shows the camp total honestly. */}
      {effectiveShowCost && showBreakdown && (
        <div className="text-[11px] text-gray-400 mt-0.5">
          ${Math.round(campPart).toLocaleString()} camp · ${Math.round(fuelPart!).toLocaleString()} fuel
        </div>
      )}
      {/* Bottom meta row — "N stops · M booked" on the left (only when stops
          exist; a trip with no stops omits it rather than showing 0/0), and
          the lifecycle line "Started <date> · Edited <relative>" right-aligned
          opposite it (replaces the old standalone relative stamp that used to
          sit in the stats row above). Both share the row's muted tone. */}
      {(showStopsLine || showLifecycle) && (
        <div className="flex items-center justify-between gap-2 text-xs text-gray-400 mt-1">
          <span>
            {showStopsLine
              ? <>{stopCount} stop{stopCount === 1 ? '' : 's'} · {bookedCount} booked</>
              : null}
          </span>
          {showLifecycle && (
            <span className="text-right flex-shrink-0">
              {trip.createdAt ? `Started ${lifecycleDate(trip.createdAt)}` : ''}
              {trip.createdAt && trip.updatedAt ? ' · ' : ''}
              {trip.updatedAt ? `Edited ${relativeTime(trip.updatedAt, { short: true })}` : ''}
            </span>
          )}
        </div>
      )}
    </Link>
  )
}
