/**
 * Single source of truth for deriving a trip's round-trip vs one-way SHAPE
 * from its ordered stops. Mirrors the BUG-4 read/write rule used by:
 *   - controllers/ai.ts buildLiveTripState (read path; prefers the stored
 *     Trip.tripType, falls back to this when the column is null)
 *   - controllers/trips.ts syncTripEndpoints (write path; keeps Trip.tripType
 *     accurate after modify-mode createStop/deleteStop change the shape)
 * Keep this the ONLY copy of the rule on the server — do not re-inline it.
 *
 * Rule: the home stop is the first `type: 'HOME'` stop (else stops[0]); a trip
 * is a ROUND_TRIP exactly when the LAST stop is a distinct stop from the home
 * stop whose locationName (lowercased + trimmed) matches the home stop's —
 * i.e. the trip closes by returning to its origin city. Everything else
 * (including degenerate/empty stop lists) is ONE_WAY.
 *
 * Pass stops ordered by `order` ascending. Only `type` and `locationName` are
 * read, so the caller may select just those columns.
 */
export type TripShape = 'ROUND_TRIP' | 'ONE_WAY'

export function computeTripShape(
  stops: Array<{ type?: string | null; locationName?: string | null }>,
): TripShape {
  if (!stops || stops.length === 0) return 'ONE_WAY'
  const homeStop = stops.find(s => s.type === 'HOME') ?? stops[0]
  const lastStop = stops[stops.length - 1]
  const norm = (n?: string | null) => (n ?? '').toLowerCase().trim()
  const isRoundTrip =
    lastStop !== homeStop &&
    norm(lastStop.locationName) === norm(homeStop.locationName)
  return isRoundTrip ? 'ROUND_TRIP' : 'ONE_WAY'
}
