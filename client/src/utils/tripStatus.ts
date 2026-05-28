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
 * For trips with no committed dates yet (Trip.startDate or endDate null —
 * e.g. an early-stage plan the user hasn't anchored to a calendar), the
 * result is PLANNING. Adding dates later via the AI shift_trip_dates flow
 * (or, in step 2, a direct date editor) will transition them naturally.
 */
export function deriveTripStatus(trip: Trip, today: Date = new Date()): TripStatus {
  const start = parseTripDate(trip.startDate)
  const end = parseTripDate(trip.endDate)
  if (!start || !end) return 'PLANNING'

  // Anchor today to local noon on the same calendar day, mirroring
  // parseTripDate's output shape. Comparing two local-noon Dates is a
  // straightforward calendar-day comparison — no DST/timezone surprises.
  const todayAnchor = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0)

  if (todayAnchor < start) return 'PLANNING'
  if (todayAnchor > end) return 'COMPLETED'
  return 'ACTIVE'
}
