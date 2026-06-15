import type { Stop } from '../types'

/**
 * User-facing stop count — the number of stops as the USER counts them, which
 * excludes the HOME origin ("Starting point") and, on round trips, the closing
 * return-home stop ("Return home"). Mirrors the exclusion rule in
 * server/src/controllers/ai.ts → buildLiveTripState (the source of truth for
 * user-facing stop vocabulary). Keep the two in sync: if buildLiveTripState's
 * HOME / return-home detection changes, update this helper to match.
 *
 * Rule (1:1 with buildLiveTripState):
 *  - exclude any stop with type === 'HOME' (the departure / "Starting point")
 *  - exclude the closing return-home stop: a HOME stop exists, the stop is NOT
 *    that home stop, it is the LAST stop in the array, and its locationName
 *    (lowercased + trimmed) matches the home stop's locationName.
 *  - everything else counts, INCLUDING OVERNIGHT_ONLY transit waypoints.
 *
 * The raw stops.length is NOT user-facing — it counts the origin (and the
 * return-home row on round trips), so it reads one too high on one-way trips
 * and two too high on round trips.
 */
export function userFacingStopCount(stops?: Stop[] | null): number {
  if (!Array.isArray(stops) || stops.length === 0) return 0

  const homeStop = stops.find(s => s.type === 'HOME')
  const lastStop = stops[stops.length - 1]
  const isReturnHome = (s: Stop): boolean =>
    !!homeStop &&
    s !== homeStop &&
    s === lastStop &&
    s.locationName?.toLowerCase().trim() === homeStop.locationName?.toLowerCase().trim()

  return stops.filter(s => s.type !== 'HOME' && !isReturnHome(s)).length
}
