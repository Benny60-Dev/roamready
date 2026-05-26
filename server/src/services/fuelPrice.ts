import axios from 'axios'
import { getCache, setCache } from '../utils/redis'

/**
 * Regional fuel-price lookup for the trip-cost estimate.
 *
 * Data source: EIA API v2, "Weekly Retail Gasoline and Diesel Prices" dataset
 * (https://api.eia.gov/v2/petroleum/pri/gnd/data/). EIA publishes Mondays, so
 * a 7-day cache is plenty; a single Redis hit at `fuelprices:current` holds
 * every region × fuel-grade slot so each per-leg lookup is O(1) after the
 * first fetch of the week.
 *
 * Fallback strategy — the public `getFuelPrice` MUST never throw and MUST
 * always return a usable per-gallon number. Each call goes through three
 * tiers in order:
 *   1. 'cache'    — Redis has a current set AND the requested slot is filled
 *   2. 'eia'      — cache miss / stale: fetch the full set live from EIA,
 *                   store it, return the requested slot
 *   3. 'fallback' — EIA unreachable / key missing / specific slot blank:
 *                   return a hardcoded national-average estimate so the
 *                   trip-cost estimator always has *something* to multiply
 *
 * The `source` field on the return value tells the caller which tier
 * answered so the UI can show a "live" vs "estimated from cache" badge
 * later if we want, and so the test route below can prove the live path
 * works without writing extra instrumentation.
 *
 * Security: EIA_API_KEY is read from process.env only — never hardcoded,
 * never logged. The key is passed as a query parameter to EIA per their
 * docs; errors log only the duoarea / product / HTTP status, never the
 * URL or the key.
 *
 * Verified EIA response shape (sample, regular gasoline / US national,
 * 2026-05-18 observation):
 *   { period, duoarea, area-name, product, product-name, process,
 *     series, series-description, value, units }
 * Where `value` is a STRING (e.g. "4.49") that we parse to number.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type FuelGrade = 'gas' | 'diesel'

/** EIA region identifier we map every US state to. NUS = US national average,
 *  used as the safety net when a stop has no state or an unknown one. */
export type FuelRegionCode = 'US' | 'CA' | 'PADD1' | 'PADD2' | 'PADD3' | 'PADD4' | 'PADD5'

export type FuelPriceSource = 'eia' | 'cache' | 'fallback'

export interface FuelPriceResult {
  /** $/gallon. Always a finite number — fallback ensures this. */
  pricePerGallon: number
  /** Which tier produced the value (see header comment). */
  source: FuelPriceSource
  /** Human-readable region label, e.g. "California", "Midwest". */
  region: string
  /** EIA region code, for cache keying / debugging. */
  paddCode: FuelRegionCode
  /** ISO date of the underlying EIA observation when source is 'eia' or
   *  'cache'. For 'fallback', the date the hardcoded table was last
   *  refreshed (in code). */
  asOf: string
}

// ─── State → region lookup ────────────────────────────────────────────────────

// California is its own EIA series (SCA) because retail prices diverge enough
// from the rest of PADD 5 — special fuel blends, state taxes — that blending
// CA into a generic PADD 5 number would mislead trip estimates crossing CA.
const CA_CODES = new Set(['CA'])

const PADD1_CODES = new Set([
  // East Coast
  'CT', 'DE', 'FL', 'GA', 'ME', 'MD', 'MA', 'NH', 'NJ', 'NY', 'NC',
  'PA', 'RI', 'SC', 'VT', 'VA', 'WV', 'DC',
])
const PADD2_CODES = new Set([
  // Midwest
  'IL', 'IN', 'IA', 'KS', 'KY', 'MI', 'MN', 'MO', 'NE', 'ND',
  'OH', 'OK', 'SD', 'TN', 'WI',
])
const PADD3_CODES = new Set([
  // Gulf Coast
  'AL', 'AR', 'LA', 'MS', 'NM', 'TX',
])
const PADD4_CODES = new Set([
  // Rocky Mountain
  'CO', 'ID', 'MT', 'UT', 'WY',
])
const PADD5_CODES = new Set([
  // West Coast — CA intentionally omitted; handled by CA_CODES above.
  'AK', 'AZ', 'HI', 'NV', 'OR', 'WA',
])

// Stops store locationState as either a 2-letter code ("CA") or a full name
// ("California"). This lowercase-keyed map normalizes either to the 2-letter
// code so the PADD lookups above can be Set-based.
const STATE_NAME_TO_CODE: Record<string, string> = {
  'alabama': 'AL',         'alaska': 'AK',          'arizona': 'AZ',
  'arkansas': 'AR',        'california': 'CA',      'colorado': 'CO',
  'connecticut': 'CT',     'delaware': 'DE',        'florida': 'FL',
  'georgia': 'GA',         'hawaii': 'HI',          'idaho': 'ID',
  'illinois': 'IL',        'indiana': 'IN',         'iowa': 'IA',
  'kansas': 'KS',          'kentucky': 'KY',        'louisiana': 'LA',
  'maine': 'ME',           'maryland': 'MD',        'massachusetts': 'MA',
  'michigan': 'MI',        'minnesota': 'MN',       'mississippi': 'MS',
  'missouri': 'MO',        'montana': 'MT',         'nebraska': 'NE',
  'nevada': 'NV',          'new hampshire': 'NH',   'new jersey': 'NJ',
  'new mexico': 'NM',      'new york': 'NY',        'north carolina': 'NC',
  'north dakota': 'ND',    'ohio': 'OH',            'oklahoma': 'OK',
  'oregon': 'OR',          'pennsylvania': 'PA',    'rhode island': 'RI',
  'south carolina': 'SC',  'south dakota': 'SD',    'tennessee': 'TN',
  'texas': 'TX',           'utah': 'UT',            'vermont': 'VT',
  'virginia': 'VA',        'washington': 'WA',      'west virginia': 'WV',
  'wisconsin': 'WI',       'wyoming': 'WY',
  'district of columbia': 'DC', 'washington dc': 'DC', 'washington, dc': 'DC',
}

function normalizeStateCode(state: string | null | undefined): string | null {
  if (!state) return null
  const trimmed = state.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length === 2) return trimmed.toUpperCase()
  return STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null
}

/** Resolve a state (2-letter code OR full name) to its EIA region code +
 *  human label. Empty / unknown state defaults to the US national average. */
export function stateToFuelRegion(
  state: string | null | undefined,
): { paddCode: FuelRegionCode; region: string } {
  const code = normalizeStateCode(state)
  if (!code) return { paddCode: 'US', region: 'US average' }
  if (CA_CODES.has(code)) return { paddCode: 'CA', region: 'California' }
  if (PADD1_CODES.has(code)) return { paddCode: 'PADD1', region: 'East Coast' }
  if (PADD2_CODES.has(code)) return { paddCode: 'PADD2', region: 'Midwest' }
  if (PADD3_CODES.has(code)) return { paddCode: 'PADD3', region: 'Gulf Coast' }
  if (PADD4_CODES.has(code)) return { paddCode: 'PADD4', region: 'Rocky Mountain' }
  if (PADD5_CODES.has(code)) return { paddCode: 'PADD5', region: 'West Coast' }
  return { paddCode: 'US', region: 'US average' }
}

// ─── EIA series identifiers ───────────────────────────────────────────────────

// EIA v2 region identifier ("duoarea") per FuelRegionCode. Confirmed against
// the live API: e.g. duoarea=NUS returned area-name="U.S." with series
// "EMM_EPMR_PTE_NUS_DPG" (U.S. Regular All Formulations Retail Gasoline).
const DUOAREA: Record<FuelRegionCode, string> = {
  US:    'NUS',
  CA:    'SCA',
  PADD1: 'R10',
  PADD2: 'R20',
  PADD3: 'R30',
  PADD4: 'R40',
  PADD5: 'R50',
}

// EIA v2 product identifier ("product") per fuel grade.
// EPMR  = Regular Gasoline retail
// EPD2D = No. 2 ultra-low-sulfur on-highway diesel retail
const PRODUCT: Record<FuelGrade, string> = {
  gas:    'EPMR',
  diesel: 'EPD2D',
}

const REGION_LABELS: Record<FuelRegionCode, string> = {
  US:    'US average',
  CA:    'California',
  PADD1: 'East Coast',
  PADD2: 'Midwest',
  PADD3: 'Gulf Coast',
  PADD4: 'Rocky Mountain',
  PADD5: 'West Coast',
}

const ALL_REGION_CODES: FuelRegionCode[] = ['US', 'CA', 'PADD1', 'PADD2', 'PADD3', 'PADD4', 'PADD5']

// ─── Fallback table ───────────────────────────────────────────────────────────

// Approximate retail prices in $/gallon. Used ONLY when EIA is unreachable,
// the key is missing, or a specific region/grade slot came back blank from
// EIA. These numbers were snapshotted from EIA in May 2026 and are intended
// as a "trip estimate won't be wildly wrong" floor, not a substitute for live
// data. Bump them periodically (or replace this table with a build-time
// snapshot fetch) if the EIA path stays dark long enough that fallbacks are
// what users actually see.
const FALLBACK_AS_OF = '2026-05-18'
const FALLBACK_PRICES: Record<FuelRegionCode, Record<FuelGrade, number>> = {
  US:    { gas: 4.50, diesel: 4.85 },
  CA:    { gas: 5.45, diesel: 5.55 },
  PADD1: { gas: 4.40, diesel: 4.85 },
  PADD2: { gas: 4.35, diesel: 4.85 },
  PADD3: { gas: 4.15, diesel: 4.65 },
  PADD4: { gas: 4.55, diesel: 4.85 },
  PADD5: { gas: 4.95, diesel: 5.20 },
}

// ─── Cache shape ──────────────────────────────────────────────────────────────

// Single consolidated cache entry holds every region × fuel slot. One Redis
// hit on each per-leg lookup; one full refresh on cache miss. Slot values
// can be null when EIA returned no data for that specific region/grade
// combination — the caller falls back to FALLBACK_PRICES for nulls.
interface CachedPriceSet {
  prices: Record<FuelRegionCode, { gas: number | null; diesel: number | null }>
  asOf: string       // ISO date of the underlying EIA observation
  fetchedAt: number  // epoch ms when we hit EIA, for debugging
}

const CACHE_KEY = 'fuelprices:current'
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days — EIA publishes weekly

// ─── EIA fetch (single slot) ──────────────────────────────────────────────────

async function fetchOneSlot(
  duoarea: string,
  product: string,
): Promise<{ value: number; period: string } | null> {
  const apiKey = process.env.EIA_API_KEY
  if (!apiKey) return null

  // URLSearchParams handles EIA's bracket-style facet params + repeated keys
  // without the axios paramsSerializer dance. The key is appended via the
  // params builder and never appears in any log or string we emit.
  const params = new URLSearchParams()
  params.set('api_key', apiKey)
  params.set('frequency', 'weekly')
  params.set('data[0]', 'value')
  params.append('facets[duoarea][]', duoarea)
  params.append('facets[product][]', product)
  params.set('sort[0][column]', 'period')
  params.set('sort[0][direction]', 'desc')
  params.set('length', '1')

  const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?${params.toString()}`

  try {
    const res = await axios.get(url, { timeout: 10_000 })
    const series = res.data?.response?.data
    if (!Array.isArray(series) || series.length === 0) return null
    const latest = series[0]
    // EIA returns `value` as a string ("4.49"); Number() normalizes both
    // string and (rare) number cases.
    const value = typeof latest.value === 'number' ? latest.value : Number(latest.value)
    if (!Number.isFinite(value)) return null
    return { value, period: String(latest.period ?? '') }
  } catch (err: any) {
    // Log duoarea + product + status only — NEVER the URL (which contains
    // the API key) and NEVER the key itself.
    console.warn(
      '[fuelPrice] EIA fetch failed duoarea=%s product=%s status=%s message=%s',
      duoarea, product, err?.response?.status ?? 'n/a', err?.message ?? 'unknown',
    )
    return null
  }
}

// ─── EIA fetch (all 14 slots in one round trip) ──────────────────────────────

async function fetchFullPriceSet(): Promise<CachedPriceSet | null> {
  // 7 regions × 2 fuels = 14 series fetches, all independent. Parallel.
  const tasks: Array<{
    region: FuelRegionCode
    fuel: FuelGrade
    promise: Promise<{ value: number; period: string } | null>
  }> = []
  for (const region of ALL_REGION_CODES) {
    for (const fuel of ['gas', 'diesel'] as FuelGrade[]) {
      tasks.push({
        region,
        fuel,
        promise: fetchOneSlot(DUOAREA[region], PRODUCT[fuel]),
      })
    }
  }
  const results = await Promise.all(tasks.map(t => t.promise))

  // Stitch results back onto a region-keyed object. Default each slot to null
  // so callers know definitively whether EIA had data for that slot.
  const prices = {} as Record<FuelRegionCode, { gas: number | null; diesel: number | null }>
  for (const region of ALL_REGION_CODES) {
    prices[region] = { gas: null, diesel: null }
  }
  let asOf = ''
  let anySuccess = false
  for (let i = 0; i < tasks.length; i++) {
    const { region, fuel } = tasks[i]
    const result = results[i]
    if (result) {
      prices[region][fuel] = result.value
      anySuccess = true
      // First non-empty period wins as the cache's overall asOf — all 14
      // slots should report the same weekly period when EIA is healthy.
      if (!asOf) asOf = result.period
    }
  }

  // If every single fetch failed, don't cache an all-null set — that'd lock
  // us out of EIA for 7 days behind a stale dead cache. Let the next call
  // try EIA again.
  if (!anySuccess) return null

  return {
    prices,
    asOf: asOf || new Date().toISOString().slice(0, 10),
    fetchedAt: Date.now(),
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the current per-gallon retail price for a fuel grade in the region
 * containing the given state. Three-tier resolution:
 *   1. Redis cache (`fuelprices:current`, 7-day TTL) — if both the cache
 *      exists AND the requested slot is non-null → source 'cache'
 *   2. Live EIA fetch — populates the full 7-region × 2-fuel cache in one
 *      parallel batch → source 'eia'
 *   3. Hardcoded FALLBACK_PRICES table → source 'fallback'
 *
 * NEVER throws. NEVER returns a non-finite number. Callers can trust the
 * returned pricePerGallon to multiply directly.
 */
export async function getFuelPrice(
  state: string | null | undefined,
  fuelType: FuelGrade,
): Promise<FuelPriceResult> {
  const { paddCode, region } = stateToFuelRegion(state)

  // ── Tier 1: cache ──────────────────────────────────────────────────────
  // Cache read is best-effort — a Redis hiccup never blocks the price.
  let cached: CachedPriceSet | null = null
  try {
    cached = await getCache<CachedPriceSet>(CACHE_KEY)
  } catch (err: any) {
    console.warn('[fuelPrice] cache read failed: %s', err?.message)
  }
  if (cached) {
    const cachedSlot = cached.prices?.[paddCode]?.[fuelType]
    if (typeof cachedSlot === 'number' && Number.isFinite(cachedSlot)) {
      return { pricePerGallon: cachedSlot, source: 'cache', region, paddCode, asOf: cached.asOf }
    }
    // Cache exists but THIS slot is null — drop through to fallback rather
    // than re-fetching, because a full refetch every miss-slot would defeat
    // the cache. The fallback handles this gracefully.
  }

  // ── Tier 2: live EIA fetch (cold cache only) ───────────────────────────
  if (!cached) {
    const fresh = await fetchFullPriceSet()
    if (fresh) {
      // Best-effort cache write — never block the response on Redis.
      try {
        await setCache(CACHE_KEY, fresh, CACHE_TTL_SECONDS)
      } catch (err: any) {
        console.warn('[fuelPrice] cache write failed: %s', err?.message)
      }
      const freshSlot = fresh.prices?.[paddCode]?.[fuelType]
      if (typeof freshSlot === 'number' && Number.isFinite(freshSlot)) {
        return { pricePerGallon: freshSlot, source: 'eia', region, paddCode, asOf: fresh.asOf }
      }
      // Fall through to fallback: EIA succeeded for OTHER slots but not
      // this specific region+fuel combination.
    }
  }

  // ── Tier 3: hardcoded fallback ─────────────────────────────────────────
  const fallback = FALLBACK_PRICES[paddCode][fuelType]
  return {
    pricePerGallon: fallback,
    source: 'fallback',
    region,
    paddCode,
    asOf: FALLBACK_AS_OF,
  }
}

// ─── Per-trip fuel-cost estimate ──────────────────────────────────────────────

/**
 * Per-leg breakdown — one entry per consecutive stop pair on the trip. The
 * leg is priced by its DESTINATION state (where the driver fuels up on
 * arrival), so a Mesa→Moab leg is priced at Utah rates and the Moab→Mesa
 * return is priced at Arizona rates.
 */
export interface LegFuelEstimate {
  fromOrder: number
  toOrder: number
  /** Destination state for this leg — what determined the pricing region. */
  toState: string | null
  miles: number
  pricePerGallon: number
  region: string
  paddCode: FuelRegionCode
  source: FuelPriceSource
  /** $-cost for this leg (miles / mpg) * pricePerGallon, rounded to cents. */
  cost: number
}

export interface TripFuelEstimate {
  /** Sum of perLeg.cost, rounded to cents. 0 when noEstimate is true. */
  total: number
  /** Which grade was priced — derived from rig.fuelType (case-insensitive
   *  match on "diesel" → diesel, everything else → gas). */
  fuelType: FuelGrade
  perLeg: LegFuelEstimate[]
  /** Worst-case source across all legs: 'fallback' if any leg used the
   *  hardcoded table, 'cache' if any was a cache hit (no fallbacks), else
   *  'eia' (all live). Gives the UI one summary signal for "how live is
   *  this estimate?" without iterating perLeg. */
  source: FuelPriceSource
  /** Most-recent EIA observation date across legs that produced eia/cache
   *  values; null when every leg fell to fallback. */
  asOf: string | null
  /** True when the estimate couldn't be computed (e.g. rig has no MPG,
   *  trip has fewer than 2 stops). The caller should NOT use `total` in
   *  this case — it's 0 to satisfy the type but doesn't mean "$0 fuel". */
  noEstimate?: boolean
  noEstimateReason?: string
  /** The MPG figure actually used in the formula (miles / mpgUsed). For
   *  trailers this is mpgTowing (or solo mpg as fallback); for motorhomes
   *  it's mpgTowing when the toad's along and isTowing, else solo mpg.
   *  Null in the noEstimate path. Pass 3 surfaces this in the disclosure
   *  ("Estimated at 12 MPG, towing"). */
  mpgUsed: number | null
  /** Why mpgUsed is what it is — drives the disclosure copy in Pass 3.
   *   'towing' → trailer rig OR motorhome with toad attached this trip
   *   'solo'   → motorhome without toad (or trailer that has no mpgTowing
   *              and is using solo mpg as the fallback)
   *  Null in the noEstimate path. */
  mpgBasis: 'solo' | 'towing' | null
  /** Resolved fuel grade — same as `fuelType` above. Repeated under this
   *  name so Pass 3 doesn't have to know which field is "the one used"
   *  vs "the rig's nominal fuelType"; for trailers these can differ
   *  (e.g. a diesel truck pulling a gasoline-stove travel trailer where
   *  the trailer's `fuelType` is irrelevant to the burn). */
  fuelTypeUsed: FuelGrade
}

/**
 * Normalize the free-form rig.fuelType string ("Gas", "gasoline", "Diesel",
 * "DIESEL", "propane", null) to our 'gas' | 'diesel' enum. Default = gas
 * (most rigs); anything containing "diesel" case-insensitively → diesel.
 * Propane / electric / unknown all fall back to gas pricing — the estimate
 * for those rigs is wrong but doesn't crash, which is the right tradeoff
 * until those user cohorts are large enough to need their own data feed.
 */
function normalizeFuelType(raw: string | null | undefined): FuelGrade {
  if (!raw) return 'gas'
  return raw.toLowerCase().includes('diesel') ? 'diesel' : 'gas'
}

/**
 * Haversine great-circle distance in miles between two lat/lng points.
 * Mirrors the client-side calcDistanceMiles in TripSummaryPage so server-
 * computed leg miles match the displayed total when stop.driveDistanceMiles
 * isn't populated (legacy trips before the Routes API integration).
 */
function calcDistanceMiles(
  lat1: number | null | undefined, lng1: number | null | undefined,
  lat2: number | null | undefined, lng2: number | null | undefined,
): number {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return 0
  const R = 3958.8 // Earth radius, miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

// Minimal duck-typed shapes — kept local so this service doesn't import from
// @prisma/client (and so it works equally well against either Prisma rows
// or hand-constructed test objects).
interface StopShape {
  order: number
  locationState: string | null
  latitude: number | null
  longitude: number | null
  driveDistanceMiles: number | null
}
// ─── Vehicle-type taxonomy ────────────────────────────────────────────────────
//
// Rig.vehicleType is an enum on the DB side (VehicleType in schema.prisma).
// The values are inlined as a string-literal union here so this service never
// has to import from @prisma/client (kept duck-typed for testability and so a
// schema-side rename surfaces as a typecheck failure in the right place).
//
// The taxonomy drives two decisions:
//   1. WHICH MPG to use (solo vs towing) — see effectiveMpg below.
//   2. WHICH FUEL TYPE to price the gallons at — trailer rigs price at the
//      tow vehicle's fuel (towedFuelType), since the trailer has no engine;
//      motorhomes price at their own fuel.
//
// TRAILER types ARE the thing being towed (no engine of their own); they
// are ALWAYS effectively in a "towing" mileage regime — the user reports
// mpgTowing as "how does my truck do with this trailer hitched."
// MOTORHOME types drive solo by default and only enter the towing regime
// when isTowing && bringingTowed (toad along for this trip).
// CAR_CAMPING is treated motorhome-like — drives solo, has its own fuel,
// no towing concept supported in the UI today.
const TRAILER_TYPES = new Set<string>([
  'FIFTH_WHEEL', 'TRAVEL_TRAILER', 'TOY_HAULER', 'POP_UP',
])

/** True when the rig itself IS the towed unit (no engine). The relevant
 *  drive-physics for fuel cost is then the tow vehicle, not the trailer. */
function isTrailerType(vehicleType: string | null | undefined): boolean {
  if (!vehicleType) return false
  return TRAILER_TYPES.has(vehicleType)
}

interface RigShape {
  fuelType: string | null
  mpg: number | null
  /** Towing-adjusted MPG. For TRAILER rigs this is the primary figure (the
   *  tow vehicle's mpg with the trailer hitched). For MOTORHOMES it's the
   *  mpg while flat-towing a toad. Null → fall back to solo `mpg`. */
  mpgTowing: number | null
  /** Discriminator for the trailer-vs-motorhome decision. String-typed
   *  (not the Prisma enum) to keep this service un-coupled from generated
   *  types — passes through whatever the controller selects. */
  vehicleType: string | null
  /** True when a motorhome is flat-towing a toad/trailer on this rig as
   *  configured in the user's profile. Trailers leave this false (they
   *  ARE the towed thing). Combined with trip.bringingTowed to decide
   *  whether the motorhome's towing-mpg applies to a given trip. */
  isTowing: boolean | null
  /** VEHICLE | TRAILER | null — only meaningful when isTowing is true.
   *  Currently informational; kept on the shape because the controller
   *  selects it and Pass 3's disclosure may use it. */
  towedType: string | null
  /** The TOW VEHICLE's fuel type (the truck pulling a trailered rig).
   *  Used for fuel pricing when isTrailerType — falls back to fuelType
   *  if the user didn't capture this field on their trailered rig. */
  towedFuelType: string | null
}

/**
 * Compute the trip's per-leg + total fuel-cost estimate. Each leg is priced
 * by the destination stop's state (where the driver is going TO, which is
 * where they'd realistically fuel up on arrival). Cold-cache calls populate
 * `fuelprices:current` on the first leg's getFuelPrice call; subsequent
 * legs hit the warm cache, so a 7-leg trip is one EIA round-trip plus six
 * Redis hits.
 *
 * Divide-by-zero / no-data guards:
 *   - rig missing or rig.mpg ≤ 0  → noEstimate=true, total=0
 *   - fewer than 2 stops          → noEstimate=true, total=0
 *   - a leg with 0 miles (e.g. stop with no coords AND no Routes API data)
 *                                  → that leg contributes $0, doesn't crash
 *
 * NEVER returns Infinity / NaN / undefined. The result.total is always a
 * finite, non-negative number safe to display directly.
 */
export async function computeFuelEstimate(
  stops: StopShape[],
  rig: RigShape | null | undefined,
  opts?: {
    /** Per-trip "am I bringing the toad" answer from the
     *  ConfirmVehiclesModal (Block 8). Only consulted for motorhome rigs
     *  with isTowing=true — combined with that flag to decide whether the
     *  towing-mpg regime applies to THIS trip. null = not asked / unknown;
     *  the helper treats null as "yes" to match the modal's default
     *  selection ("if you set up your rig as a tower, assume you're
     *  bringing the toad unless you said otherwise"). Trailer rigs ignore
     *  this entirely — they're always in the towing regime. */
    bringingTowed?: boolean | null
  },
): Promise<TripFuelEstimate> {
  // ─── Determine the towing regime for THIS trip ────────────────────────────
  // Two questions:
  //   1. WHICH MPG to use (solo `mpg` vs `mpgTowing`)?
  //   2. WHICH FUEL TYPE to price (the rig's own vs the tow-vehicle's)?
  // Trailers are ALWAYS effectively towing (the rig itself has no engine, so
  // the relevant figures are the tow vehicle's). Motorhomes are conditional:
  // towing applies only when their profile says isTowing AND the user said
  // "yes, I'm bringing the toad" on this trip (bringingTowed=true or null —
  // null defaults to yes to match the modal's UX).
  const trailer = isTrailerType(rig?.vehicleType)
  const motorhomeTowing = !!(rig?.isTowing) && (opts?.bringingTowed ?? true)
  const towing = trailer || motorhomeTowing

  // Effective MPG:
  //   · trailer: prefer mpgTowing, fall back to solo mpg (lets a user who
  //     only filled in the legacy mpg field still get a non-null estimate).
  //   · motorhome towing: prefer mpgTowing, fall back to solo mpg.
  //   · motorhome solo: use solo mpg.
  // Truthy-check (>0) on each candidate so a 0 / negative value behaves
  // like "not set" rather than divide-by-zero further down.
  const mpgTowingVal =
    typeof rig?.mpgTowing === 'number' && rig.mpgTowing > 0 ? rig.mpgTowing : null
  const mpgSoloVal =
    typeof rig?.mpg === 'number' && rig.mpg > 0 ? rig.mpg : null
  const effectiveMpg = towing ? (mpgTowingVal ?? mpgSoloVal) : mpgSoloVal
  // Was the FINAL pick actually the towing figure? When a trailer has only
  // solo mpg set, we used solo as a fallback — basis is 'solo' in that
  // case (honest disclosure: "we used your solo mpg because no towing
  // mpg was set"). Pass 3's disclosure copy depends on this distinction.
  const mpgBasis: 'solo' | 'towing' | null =
    effectiveMpg == null ? null : (towing && effectiveMpg === mpgTowingVal ? 'towing' : 'solo')

  // Effective fuel type:
  //   · trailer: prefer towedFuelType (the tow vehicle's), fall back to
  //     the rig's own fuelType. A trailered rig's own fuelType is usually
  //     irrelevant (propane stove, etc.) but is a safe fallback so we
  //     don't price diesel-when-actually-gas just because the user
  //     skipped the towed-fuel field.
  //   · motorhome: use the rig's own fuelType, same as pre-rework.
  const fuelType: FuelGrade = trailer
    ? normalizeFuelType(rig?.towedFuelType ?? rig?.fuelType)
    : normalizeFuelType(rig?.fuelType)

  if (!effectiveMpg || effectiveMpg <= 0) {
    return {
      total: 0,
      fuelType,
      perLeg: [],
      source: 'fallback',
      asOf: null,
      noEstimate: true,
      noEstimateReason: rig ? 'Rig MPG not set' : 'No rig assigned to trip',
      mpgUsed: null,
      mpgBasis: null,
      fuelTypeUsed: fuelType,
    }
  }

  const sorted = [...stops].sort((a, b) => a.order - b.order)
  if (sorted.length < 2) {
    return {
      total: 0,
      fuelType,
      perLeg: [],
      source: 'fallback',
      asOf: null,
      noEstimate: true,
      noEstimateReason: 'Trip needs at least 2 stops to compute legs',
      mpgUsed: null,
      mpgBasis: null,
      fuelTypeUsed: fuelType,
    }
  }

  // Walk consecutive pairs. Sequential await is fine here — the first call's
  // EIA fetch primes the consolidated `fuelprices:current` cache for every
  // region, so every subsequent leg is a Redis hit even when they're in
  // different PADD regions. No parallelization payoff vs the simpler walk.
  const perLeg: LegFuelEstimate[] = []
  let total = 0
  const sourceSet = new Set<FuelPriceSource>()
  const asOfSet = new Set<string>()

  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1]
    const to = sorted[i]
    const miles = to.driveDistanceMiles
      ?? calcDistanceMiles(from.latitude, from.longitude, to.latitude, to.longitude)
    const price = await getFuelPrice(to.locationState, fuelType)
    // miles=0 (no coords + no Routes API distance) gracefully contributes
    // $0 to the total rather than failing. Same for miles<0 (defensive).
    const cost = miles > 0 ? (miles / effectiveMpg) * price.pricePerGallon : 0
    perLeg.push({
      fromOrder: from.order,
      toOrder: to.order,
      toState: to.locationState,
      miles,
      pricePerGallon: price.pricePerGallon,
      region: price.region,
      paddCode: price.paddCode,
      source: price.source,
      cost: Math.round(cost * 100) / 100,
    })
    total += cost
    sourceSet.add(price.source)
    if (price.asOf) asOfSet.add(price.asOf)
  }

  // Aggregate source: any fallback → 'fallback'; else any cache → 'cache';
  // else all 'eia'. Gives the UI a single "data quality" hint.
  const overallSource: FuelPriceSource =
    sourceSet.has('fallback') ? 'fallback' :
    sourceSet.has('cache') ? 'cache' :
    'eia'

  // Most recent observation date across legs. ISO YYYY-MM-DD sorts
  // lexically equal to chronologically, so .sort().pop() yields the max.
  const asOf = asOfSet.size > 0 ? (Array.from(asOfSet).sort().pop() ?? null) : null

  return {
    total: Math.round(total * 100) / 100,
    fuelType,
    perLeg,
    source: overallSource,
    asOf,
    mpgUsed: effectiveMpg,
    mpgBasis,
    fuelTypeUsed: fuelType,
  }
}

// ─── Test helper (used by the temporary /api/v1/_fueltest route) ──────────────

/** Re-export region labels so the test route can list valid inputs. Not
 *  intended for production callers. */
export const FUEL_REGION_LABELS = REGION_LABELS
