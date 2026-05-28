import type { Trip, TripStatus } from '../types'
import { parseTripDate } from './dates'

/**
 * Derived trip status — pure function of the trip's committed dates and
 * today. No stored override, no manual button. The trip "is" PLANNING /
 * ACTIVE / COMPLETED by virtue of where today falls relative to its dates.
 *
 *   neither date set            → PLANNING (no committed dates yet)
 *   today < startDate           → PLANNING (trip is in the future)
 *   startDate ≤ today ≤ endDate → ACTIVE   (inclusive both ends)
 *   today > endDate             → COMPLETED (trip is in the past)
 *
 * Replaces the prior manual flow where `Trip.status` was a stored column
 * the user flipped via Start trip / Mark completed buttons. That created
 * a two-sources-of-truth bug: trips whose dates put them mid-journey
 * stayed flagged PLANNING because nobody clicked the button (3 of Cindy's
 * 5 trips were stale this way before this util landed). Deriving from
 * dates lets the trip's status track reality without ceremony.
 *
 * STOP-DATE FALLBACK — Trip.startDate / Trip.endDate can be null on real
 * trips even when the trip is actively under way. The session-promote
 * flow doesn't write startDate (the AI's plan lives on the stops, not on
 * the trip row), and shiftTripDates intentionally preserves null on the
 * Trip row via its `shifted(null) → null` rule. So a promoted-then-
 * shifted trip looks like { startDate: null, endDate: null } on the trip
 * row even when its stops carry concrete arrival/departure dates that
 * put it ACTIVE today. Without a fallback the dashboard kept reading
 * PLANNING for trips that were genuinely under way — Epic Western Loop's
 * "Start now → still PLANNING" repro.
 *
 * The fallback mirrors what the trip-page date line already does for
 * display:
 *   start = parseTripDate(trip.startDate) ?? parseTripDate(firstDatedStop.arrivalDate)
 *   end   = parseTripDate(trip.endDate)   ?? parseTripDate(lastDatedStop.departureDate)
 * where firstDatedStop / lastDatedStop are the first/last stops by
 * `order` ascending with a non-null arrival/departure. This is the same
 * anchor probe shiftTripDates uses server-side (trips.ts:587), keeping
 * client and server agreed on what "the trip's effective dates" means.
 *
 * If after the fallback either side is still null (no Trip column AND
 * no stop with the relevant date) the trip is genuinely undated — we
 * return PLANNING. That preserves the "brand-new plan with no calendar
 * commitment yet" case correctly.
 *
 * parseTripDate normalizes both wire shapes (the server emits dates as
 * 'YYYY-MM-DD' or full ISO strings depending on the path) to a local-noon
 * Date whose calendar components match the UTC date — same convention
 * buildTimeline / TripCard / formatTripDate use elsewhere in the trip
 * surfaces. Today is built the same way so the comparison basis is
 * identical and a viewer east/west of UTC sees the same status.
 *
 * Both endpoints are inclusive: a trip whose startDate is today reads
 * ACTIVE from midnight, and a trip whose endDate is today reads ACTIVE
 * all the way to end of day — the day-after is the first day it flips
 * to COMPLETED.
 *
 * Callers — TripMapPage header pill, TripCard (Dashboard grid + Session
 * planning-strip), DashboardPage tab filters, SessionPage filter — all
 * pass a Trip whose `stops` is populated (getTrips at trips.ts:93 and
 * getTrip at trips.ts:513 both `include: { stops: { orderBy: { order:
 * 'asc' } } }`). The `stops ?? []` guard below covers the type's
 * optionality, not a real runtime path.
 */
export function deriveTripStatus(trip: Trip, today: Date = new Date()): TripStatus {
  let start = parseTripDate(trip.startDate)
  let end = parseTripDate(trip.endDate)

  // Fall back to stop dates when the Trip row's start/end columns are
  // null. See "STOP-DATE FALLBACK" in the doc above for why this is
  // necessary (TL;DR: shiftTripDates preserves null on the Trip row).
  if (!start || !end) {
    const stops = trip.stops ?? []
    if (!start) {
      // First stop (by order asc) with a non-null arrivalDate. Same probe
      // shiftTripDates uses server-side to compute its shift anchor.
      const firstDatedStop = stops.find(s => s.arrivalDate != null)
      start = parseTripDate(firstDatedStop?.arrivalDate)
    }
    if (!end) {
      // Last stop with a non-null departureDate. ES2020 target → no
      // Array#findLast; walk the array in reverse instead.
      let lastDatedStop: typeof stops[number] | null = null
      for (let i = stops.length - 1; i >= 0; i--) {
        if (stops[i].departureDate != null) {
          lastDatedStop = stops[i]
          break
        }
      }
      end = parseTripDate(lastDatedStop?.departureDate)
    }
  }

  // Genuinely undated — no Trip columns AND no stops carry the relevant
  // date. Real "I haven't picked a calendar yet" state, reads PLANNING.
  if (!start || !end) return 'PLANNING'

  // Anchor today to local noon on the same calendar day, mirroring
  // parseTripDate's output shape. Comparing two local-noon Dates is a
  // straightforward calendar-day comparison — no DST/timezone surprises.
  const todayAnchor = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0)

  if (todayAnchor < start) return 'PLANNING'
  if (todayAnchor > end) return 'COMPLETED'
  return 'ACTIVE'
}
