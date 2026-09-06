/**
 * Canonical trip-total computation. Single source of truth used by every
 * surface that renders a trip's cost — itinerary stat-strip + Cost Breakdown
 * + PDF, map page, share view, dashboard card, planning-session card.
 *
 * CAMP MATH (unchanged across passes)
 *
 * Camp = Σ(siteRate × nights) over all stops, with the actual-when-booked
 * override pulled from Block 13's actualRate/actualFees. Deliberately does
 * NOT read trip.estimatedCamp — that's a stale AI guess that contradicts
 * the per-stop siteRates by 2-5×. Standardize on the per-stop walk.
 *
 * FUEL MATH (per-leg actual rework)
 *
 * fuelEst (the planning-side fuel total) comes from opts.fuelEstimate — a
 * single number the caller fetched from GET /trips/:id/fuel-estimate.
 *
 * fuelActual (the "what you've actually spent so far" fuel number) is now
 * computed by BLENDING per-leg actuals with per-leg estimates:
 *
 *   for each leg in opts.fuelPerLeg:
 *     arriving stop = stops.find(s => s.order === leg.toOrder)
 *     if arrivingStop.actualFuel is finite → use it
 *     else                                   → use leg.cost (the estimate)
 *
 * So a user who logs $245 against the Mesa→Bakersfield leg sees that ONE
 * leg's estimate replaced by $245 in actualTotal — the other N-1 legs
 * keep contributing their estimates. The pre-rework "trip.actualFuel
 * replaces the whole estimate" bug (logging $245 made actualTotal show
 * just $245 of fuel) is gone.
 *
 * `fuelActual` only becomes a real "actual" (non-null, contributes to
 * hasAnyActuals) when at least one leg has actualFuel set. A trip with
 * zero logged legs returns fuelActual=null and the actualTotal falls
 * through to the planning estimate — same behavior as the pre-rework
 * "no actuals yet" case.
 *
 * BACK-COMPAT FALLBACK
 *
 * Surfaces that DON'T pass opts.fuelPerLeg (TripCard, SharedTripPage —
 * list surfaces that read the stored Trip.estimatedFuel for fuelEst but
 * have no perLeg array) fall back to the LEGACY path: fuelActual reads
 * trip.actualFuel directly. That column stays for now as a legacy
 * fallback; the per-leg sum on Stop.actualFuel is the new source of
 * truth for the surfaces that have the data to compute it.
 *
 * INPUT SHAPE
 *
 * Duck-typed. Accepts either a saved Trip from the DB or the AI-generated
 * planning itinerary object — both have `stops` with `siteRate` + `nights`
 * + (for saved trips) `bookingStatus` / `actualRate` / `actualFees` /
 * `actualFuel`. Stops without a siteRate contribute 0 to camp; stops
 * without an actualFuel fall back to their leg's estimate.
 *
 * Numbers come back raw (not rounded) — callers round at display time so
 * the math stays composable.
 */

/** PR-6 — a transit night the drive-time engine inserts (OVERNIGHT_ONLY) has
 *  no campground and no siteRate, so it priced as $0 and the row vanished:
 *  a 6-night trip billed for 5. The rate used for such a stop is the average
 *  of the trip's other priced stops, else this default. Client-side only — a
 *  fallback is never persisted as if it were a campground quote. */
export const DEFAULT_SITE_RATE = 45

/** The nightly rate to price a stop at: its own siteRate, else the average
 *  siteRate of the trip's other priced overnight stops, else DEFAULT_SITE_RATE.
 *  Returns { rate, estimated } so a surface can tag a fallback as "est.". Stops
 *  with no nights price at 0 regardless. */
export function effectiveSiteRate(
  stop: TripTotalsInputStop,
  stops: TripTotalsInputStop[] | null | undefined,
): { rate: number; estimated: boolean } {
  if ((stop.nights ?? 0) <= 0) return { rate: 0, estimated: false }
  if (stop.siteRate != null && stop.siteRate > 0) return { rate: stop.siteRate, estimated: false }
  const priced = (stops ?? []).filter(s => s !== stop && (s.nights ?? 0) > 0 && s.siteRate != null && s.siteRate > 0)
  if (priced.length) {
    const avg = priced.reduce((sum, s) => sum + (s.siteRate as number), 0) / priced.length
    return { rate: Math.round(avg), estimated: true }
  }
  return { rate: DEFAULT_SITE_RATE, estimated: true }
}

export interface TripTotalsInputStop {
  /** Used to match this stop to a per-leg estimate (leg.toOrder === order).
   *  Only required when opts.fuelPerLeg is supplied; ignored otherwise. */
  order?: number | null
  siteRate?: number | null
  nights?: number | null
  bookingStatus?: string | null
  actualRate?: number | null
  actualFees?: number | null
  /** Per-leg actual fuel — the real cost the user recorded for the drive
   *  that arrived at THIS stop. Pass 1 of the per-leg-fuel rework added
   *  this column to Stop. Null on the first/HOME stop and un-recorded
   *  legs; finite when the user logged a value. */
  actualFuel?: number | null
}

export interface TripTotalsInput {
  stops?: TripTotalsInputStop[] | null
  /** Legacy trip-level actual fuel. Read only in the back-compat fallback
   *  path (when opts.fuelPerLeg is NOT supplied) — the per-leg blend
   *  supersedes this for surfaces that have the perLeg array in hand. */
  actualFuel?: number | null
}

/** Minimal per-leg estimate shape the blender needs. Structurally compatible
 *  with the FuelLegEstimate the server returns, so callers can pass
 *  `fuelEstimate.perLeg` directly without re-mapping. */
export interface FuelLegInput {
  toOrder: number
  cost: number
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
  /** Per-leg blended fuel actual when opts.fuelPerLeg is supplied AND at
   *  least one leg's arriving stop has Stop.actualFuel set: blended sum =
   *  Σ(actualFuel if logged, else leg.cost). When NO leg is logged, this
   *  is null (so the actualTotal falls through to the estimate — same
   *  posture as pre-rework). In the back-compat fallback path (no
   *  fuelPerLeg supplied), this reads trip.actualFuel directly as the
   *  legacy single-number actual. */
  fuelActual: number | null
  /** campEst + (fuelEst ?? 0). The planning-side total. */
  plannedTotal: number
  /** campActual + (fuelActual ?? fuelEst ?? 0). Falls through to the
   *  estimate when no actual has been logged yet, so the number is always
   *  "real where known, estimate elsewhere" rather than "ignore everything
   *  not actually paid for." */
  actualTotal: number
  /** True when at least one booked stop has actualRate set OR at least one
   *  drive leg has actualFuel logged (per-leg path) OR trip.actualFuel is
   *  set (legacy fallback path). Drives the collapse-vs-split display in
   *  the Cost Breakdown and the stat-strip label flip. */
  hasAnyActuals: boolean
  /** True when fuelEst is a finite number. Surfaces that show a camp-only
   *  total (list cards, share view) use this to decide whether to label
   *  the number "Est. cost" or "Est. camp". */
  hasFuel: boolean
}

export function computeTripTotals(
  trip: TripTotalsInput | null | undefined,
  opts?: {
    fuelEstimate?: number | null
    /** Per-leg fuel estimates from the live fuel-estimate endpoint. When
     *  supplied, fuelActual becomes a blend of per-leg actuals (from
     *  Stop.actualFuel on each leg's arriving stop) and per-leg estimates
     *  (for un-logged legs). When omitted, the helper falls back to the
     *  legacy trip.actualFuel single-number behavior — used by surfaces
     *  (list cards, share view) that don't have a perLeg array. */
    fuelPerLeg?: FuelLegInput[] | null
  },
): TripTotalsResult {
  const stops = trip?.stops ?? []

  let campEst = 0
  let campActual = 0
  let hasActualCamp = false

  for (const s of stops) {
    const nights = s.nights ?? 0
    // PR-6: an unpriced overnight (engine-inserted transit stop) is priced at
    // the trip's average rate, never $0.
    const siteRate = effectiveSiteRate(s, stops).rate
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

  // ── Fuel actual ──────────────────────────────────────────────────────────
  // Two paths:
  //  (A) Per-leg blend — opts.fuelPerLeg supplied. Walk legs; each leg's
  //      arriving stop (matched by order === leg.toOrder) contributes its
  //      actualFuel if finite, otherwise the leg's estimate (leg.cost).
  //      hasAnyLegActual tracks whether at least one leg was logged. If
  //      none were, the blended sum collapses back to estimate-only and
  //      we return fuelActual=null (so actualTotal falls through to fuelEst,
  //      matching the pre-rework "no actuals yet" behavior).
  //  (B) Legacy fallback — no fuelPerLeg supplied. Read trip.actualFuel
  //      directly. Used by list surfaces (TripCard, SharedTripPage) that
  //      don't have the perLeg array; per-leg blend is only meaningful
  //      where the live estimate is available.
  // Either path: each leg contributes EITHER an actual OR an estimate,
  // never both — no double-counting. NaN/non-finite guards on every input.
  let fuelActual: number | null = null
  let hasAnyLegActual = false

  if (Array.isArray(opts?.fuelPerLeg)) {
    // Build an order → stop lookup once so the inner loop is O(L) not O(L*N).
    const stopByOrder = new Map<number, TripTotalsInputStop>()
    for (const s of stops) {
      if (typeof s.order === 'number') stopByOrder.set(s.order, s)
    }
    let blendedSum = 0
    for (const leg of opts.fuelPerLeg) {
      const arrivingStop = stopByOrder.get(leg.toOrder)
      const legActual = arrivingStop?.actualFuel
      if (typeof legActual === 'number' && Number.isFinite(legActual)) {
        // This leg has a user-logged actual — use it, ignore the estimate.
        blendedSum += legActual
        hasAnyLegActual = true
      } else if (typeof leg.cost === 'number' && Number.isFinite(leg.cost)) {
        // Un-logged leg: fall back to its estimate so the blend remains a
        // full-trip total ("real where known, estimate elsewhere").
        blendedSum += leg.cost
      }
      // else: leg has neither finite actual nor finite estimate → 0
      // contribution. Defensive against malformed inputs.
    }
    // Only present the blend as a real "actual" when at least one leg was
    // logged. With zero logged legs the blend equals fuelEst exactly, and
    // returning that as fuelActual would falsely flip hasAnyActuals → true
    // and split the totals display when nothing is yet recorded.
    fuelActual = hasAnyLegActual ? blendedSum : null
  } else {
    // Legacy back-compat path — no perLeg array supplied. Read the trip-
    // level field directly. List surfaces (TripCard, SharedTripPage) take
    // this path; everything else passes fuelPerLeg and gets the blend.
    const rawActualFuel = trip?.actualFuel
    fuelActual =
      typeof rawActualFuel === 'number' && Number.isFinite(rawActualFuel)
        ? rawActualFuel
        : null
  }

  const plannedTotal = campEst + (fuelEst ?? 0)
  // Actual-side: prefer the blended/logged actual, fall back to the
  // estimate, fall back to 0 (camp-only context). Mirrors the Cost
  // Breakdown's display logic so helper and breakdown agree to the cent.
  const actualTotal = campActual + (fuelActual ?? fuelEst ?? 0)

  // hasAnyActuals signals "should the display split Planned vs Actual?":
  //   - per-leg path → ANY leg logged counts (hasAnyLegActual)
  //   - legacy path → trip.actualFuel set counts (fuelActual != null)
  //   - either path → any booked camp counts (hasActualCamp)
  const hasAnyFuelActual = Array.isArray(opts?.fuelPerLeg)
    ? hasAnyLegActual
    : fuelActual != null

  return {
    campEst,
    campActual,
    fuelEst,
    fuelActual,
    plannedTotal,
    actualTotal,
    hasAnyActuals: hasActualCamp || hasAnyFuelActual,
    hasFuel: fuelEst != null,
  }
}
