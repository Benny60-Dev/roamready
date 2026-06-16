import type { Stop } from '../types'
import { tripLoopsToOrigin } from './stopBadge'

/**
 * User-facing stop count — the number of stops as the USER counts them, which
 * excludes the HOME origin ("Starting point") and, on round trips, the closing
 * return-to-origin stop ("Return home"). Mirrors the exclusion rule in
 * server/src/controllers/ai.ts → buildLiveTripState.
 *
 * Rule:
 *  - exclude any stop with type === 'HOME' (the departure / "Starting point")
 *  - exclude the closing return-to-origin stop (the last stop, when the trip
 *    loops back to its own first/HOME stop — see tripLoopsToOrigin, the shared
 *    origin-based rule that getStopBadge and the server's computeTripShape also
 *    use; FINISH-ORIGIN-1 routed this through that one helper instead of a copy).
 *  - everything else counts, INCLUDING OVERNIGHT_ONLY transit waypoints.
 *
 * The raw stops.length is NOT user-facing — it counts the origin (and the
 * return-home row on round trips), so it reads one too high on one-way trips
 * and two too high on round trips.
 */
export function userFacingStopCount(stops?: Stop[] | null): number {
  if (!Array.isArray(stops) || stops.length === 0) return 0

  const lastStop = stops[stops.length - 1]
  const loops = tripLoopsToOrigin(stops)

  return stops.filter(s => s.type !== 'HOME' && !(s === lastStop && loops)).length
}
