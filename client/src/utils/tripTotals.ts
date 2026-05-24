/**
 * Canonical trip-total computation. Single source of truth used by every
 * surface that renders a trip's cost — itinerary stat-strip + Cost Breakdown
 * + PDF, map page, share view, dashboard card, planning-session card.
 *
 * THE PROBLEM THIS REPLACES
 *
 * Before this helper, six surfaces each rolled their own inline math using
 * three different field combinations:
 *   - Cost Breakdown (correct):  Σ(siteRate × nights) + live EIA fuel
 *   - Header strip + Map:        Σ(siteRate × nights) + trip.estimatedFuel
 *   - Dashboard + Share + Sess.: trip.estimatedCamp + trip.estimatedFuel
 *
 * The AI populates `trip.estimatedCamp` / `trip.estimatedFuel` at promote
 * time with trip-level guesses that disagree (often by 2-5×) with the
 * per-stop `siteRate` values the same AI also writes. Surfaces reading the
 * trip-level fields show one number; surfaces reading the per-stop sum
 * show a very different number; same trip, three answers.
 *
 * THE FIX
 *
 * Standardize on the per-stop walk everywhere. Camp = Σ(siteRate × nights)
 * over all stops (matching the Cost Breakdown's per-row display), with the
 * actual-when-booked override pulled from Block 13's actualRate/actualFees.
 * Fuel is the live EIA estimate when the caller passes it; null otherwise
 * (camp-only context — list cards, unauthed share view). This helper
 * deliberately does NOT read trip.estimatedCamp or trip.estimatedFuel —
 * those are the stale fields we're retiring from the totals path.
 *
 * INPUT SHAPE
 *
 * Duck-typed. Accepts either a saved Trip from the DB or the AI-generated
 * planning itinerary object — both have `stops` with `siteRate` + `nights`
 * + (for saved trips) `bookingStatus` / `actualRate` / `actualFees`. Stops
 * without a siteRate contribute 0, so HOME stops and return-home zero-night
 * stops fall out of the sum naturally.
 *
 * Numbers come back raw (not rounded) — callers round at display time so
 * the math stays composable.
 */

export interface TripTotalsInputStop {
  siteRate?: number | null
  nights?: number | null
  bookingStatus?: string | null
  actualRate?: number | null
  actualFees?: number | null
}

export interface TripTotalsInput {
  stops?: TripTotalsInputStop[] | null
  actualFuel?: number | null
}

export interface TripTotalsResult {
  /** Σ over stops of siteRate × nights. The canonical camp estimate, used
   *  by every surface as the planning-side number. */
  campEst: number
  /** Same sum but with the per-stop actual-when-booked override applied:
   *  CONFIRMED stops with actualRate use actualRate × nights + actualFees;
   *  every other stop falls back to siteRate × nights so this is always a
   *  full-trip total, not a "just the booked ones" subset. */
  campActual: number
  /** Live regional fuel estimate as passed via opts.fuelEstimate. Null when
   *  the caller didn't supply one (camp-only surfaces — list cards, share
   *  view) or the supplied value wasn't a finite number. NEVER reads
   *  trip.estimatedFuel — that's the stale AI guess we're retiring. */
  fuelEst: number | null
  /** trip.actualFuel when set, else null. Source of truth for "what the
   *  user actually paid for fuel so far" (logged via the Cost Breakdown's
   *  Log-fuel input). */
  fuelActual: number | null
  /** campEst + (fuelEst ?? 0). The planning-side total. */
  plannedTotal: number
  /** campActual + (fuelActual ?? fuelEst ?? 0). Falls through to the
   *  estimate when no actual has been logged yet, so the number is always
   *  "real where known, estimate elsewhere" rather than "ignore everything
   *  not actually paid for." */
  actualTotal: number
  /** True when at least one booked stop has actualRate set OR the user
   *  has logged any trip.actualFuel. Drives the collapse-vs-split display
   *  in the Cost Breakdown and the stat-strip label flip. */
  hasAnyActuals: boolean
  /** True when fuelEst is a finite number. Surfaces that show a camp-only
   *  total (list cards, share view) use this to decide whether to label
   *  the number "Est. cost" or "Est. camp". */
  hasFuel: boolean
}

export function computeTripTotals(
  trip: TripTotalsInput | null | undefined,
  opts?: { fuelEstimate?: number | null },
): TripTotalsResult {
  const stops = trip?.stops ?? []

  let campEst = 0
  let campActual = 0
  let hasActualCamp = false

  for (const s of stops) {
    const nights = s.nights ?? 0
    const siteRate = s.siteRate ?? 0
    const estForStop = siteRate * nights
    campEst += estForStop

    const isBooked = s.bookingStatus === 'CONFIRMED'
    const hasActual = isBooked && s.actualRate != null
    if (hasActual) {
      campActual += (s.actualRate ?? 0) * nights + (s.actualFees ?? 0)
      hasActualCamp = true
    } else {
      // Fall back to estimate so campActual stays a full-trip total —
      // surfaces want "real where known, estimate elsewhere," not a
      // partial that only includes booked stops.
      campActual += estForStop
    }
  }

  // Filter the supplied fuel estimate through Number.isFinite — defends
  // against accidental NaN propagation if a caller hands us bad data.
  const fuelEst =
    typeof opts?.fuelEstimate === 'number' && Number.isFinite(opts.fuelEstimate)
      ? opts.fuelEstimate
      : null

  const rawActualFuel = trip?.actualFuel
  const fuelActual =
    typeof rawActualFuel === 'number' && Number.isFinite(rawActualFuel)
      ? rawActualFuel
      : null

  const plannedTotal = campEst + (fuelEst ?? 0)
  // Actual-side: prefer logged actualFuel, fall back to the estimate, fall
  // back to 0 (camp-only context). Mirrors the Cost Breakdown's display
  // logic so the helper and the breakdown agree to the cent.
  const actualTotal = campActual + (fuelActual ?? fuelEst ?? 0)

  return {
    campEst,
    campActual,
    fuelEst,
    fuelActual,
    plannedTotal,
    actualTotal,
    hasAnyActuals: hasActualCamp || fuelActual != null,
    hasFuel: fuelEst != null,
  }
}
