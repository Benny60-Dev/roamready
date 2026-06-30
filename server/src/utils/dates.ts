/**
 * Calendar-date helpers for trip/stop dates — server-side mirror of
 * client/src/utils/dates.ts. Keep the two in sync; if a future fix to
 * one is needed, fix both.
 *
 * ──────────────────────────── THE BUG ────────────────────────────
 * Trip and stop dates are stored as UTC midnight timestamps (the AI emits
 * "2026-07-10T00:00:00Z" when it means "July 10"). Code that read them
 * with `new Date(s)` + local accessors:
 *
 *   format(new Date("2026-07-10T00:00:00Z"), 'MMM d')
 *
 * In any negative-offset timezone (Phoenix MST, all of US/Canada), the
 * JS Date constructor interprets the UTC instant in local time, shifting
 * July 10 00:00 UTC → July 9 17:00 local → format outputs "Jul 9".
 *
 * Cindy hit this on the client after asking the AI to shift her trip to
 * July 10 — the shift succeeded, the DB stored "2026-07-10", but every
 * screen showed "Jul 9". The same root cause affected the SERVER weather
 * flow: isoDate(new Date(stop.arrivalDate)) emitted the previous local
 * day for UTC-midnight arrivals in negative-offset deploy zones, so
 * Open-Meteo returned the forecast window for the day before the stop's
 * actual calendar date.
 *
 * ──────────────────────────── THE FIX ────────────────────────────
 * parseTripDate extracts the UTC y/m/d from the input and constructs a
 * Date with those components as LOCAL noon. Local-time accessors
 * (getDate/getMonth/getFullYear) then return the UTC calendar day —
 * which is what the user intended, regardless of process TZ.
 *
 * Noon (not midnight) avoids the once-a-year DST edge case where local
 * midnight doesn't exist (spring-forward gaps).
 *
 * The fix lives at the CONSTRUCTION sites (where a stored Date enters
 * the weather flow as a "base" Date), NOT at the stringification site
 * (isoDate). Rewriting isoDate to use UTC accessors would break
 * fetchHistoricalWeather's `new Date(year, monthN-1, dayN)` path, which
 * passes locally-constructed Dates through isoDate and depends on local
 * accessors matching the input integers.
 *
 * ─────────────────────────── WHY NOT @db.Date ───────────────────────────
 * The architecturally-correct fix is Postgres DATE columns + a server
 * serialization layer that emits "YYYY-MM-DD" wire strings. We chose the
 * local-noon-anchor path instead because (a) Prisma 6 still returns Date
 * objects for @db.Date so the schema change alone doesn't fix the bug,
 * (b) no multi-timezone users exist yet — single-app, local DB. The
 * deeper migration is filed as backlog (Path 1 from the May-19 scout).
 */

/**
 * Parse a date-shaped value from the DB (or anywhere) into a Date whose
 * LOCAL-time accessors return the UTC calendar day.
 *
 * Accepts:
 *   - ISO timestamp string: "2026-07-10T00:00:00.000Z" or "2026-07-10T00:00:00"
 *   - YYYY-MM-DD string: "2026-07-10"
 *   - Date instance (whose UTC components are used) — most common case here,
 *     since Prisma returns DateTime columns as Date instances.
 *   - null / undefined (passes through as null)
 *
 * Returns a Date set to LOCAL noon on the extracted calendar day, or null.
 *
 * Use this anywhere the server constructs a Date from a stored stop or
 * trip date and then needs to read its calendar day via .getDate() /
 * .getMonth() / .getFullYear(), or stringify it via isoDate(...).
 */
export function parseTripDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null

  // Already a Date instance — pull UTC components and rebuild as local noon.
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null
    return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12, 0, 0, 0)
  }

  if (typeof value !== 'string') return null

  // Bare YYYY-MM-DD (no time component). Parse parts directly so we don't
  // route through Date(string) which interprets bare dates as UTC midnight.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (dateOnly) {
    const y = Number(dateOnly[1])
    const m = Number(dateOnly[2])
    const d = Number(dateOnly[3])
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
    return new Date(y, m - 1, d, 12, 0, 0, 0)
  }

  // ISO timestamp or anything else parseable — let Date parse it, then
  // pull UTC y/m/d. This correctly handles trailing Z, ±HH:MM offsets,
  // and milliseconds.
  const parsed = new Date(value)
  if (isNaN(parsed.getTime())) return null
  return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 12, 0, 0, 0)
}

/**
 * PAST-TRAVEL-DATE BACKSTOP — deterministic year correction for a yearless
 * date the planner mis-resolved to the PAST.
 *
 * The planner delegates year resolution entirely to the LLM (the DEPARTURE
 * DATE RULE in services/ai.ts is prose, not code). When the model picks a past
 * year for a yearless date (e.g. "July 29" → 2025-07-29 emitted in 2026), the
 * past date used to persist as the trip anchor and make a still-PLANNING trip
 * read COMPLETED (deriveTripStatus is purely date-driven).
 *
 * This rolls a PAST date forward to the next FUTURE occurrence of the SAME
 * month/day (2025-07-29 with today 2026-06-29 → 2026-07-29). A date that is
 * already today-or-later is returned UNCHANGED. Apply ONLY where a forward-
 * looking travel date is being resolved/set (build/promote, and a future-trip
 * date-shift) — NEVER blindly on every recompute, which would wrongly roll a
 * genuinely-past COMPLETED trip forward.
 *
 * Calendar-day math is done in UTC because trip/stop dates are stored as
 * UTC-midnight instants; the result preserves the input's UTC time-of-day so a
 * stored UTC-midnight date stays UTC-midnight. `today` is injectable for tests.
 *
 * Edge: Feb 29 rolled into a non-leap year lands on Mar 1 (JS Date overflow) —
 * acceptable for this rare case.
 */
export function rollDateForwardIfPast(date: Date, today: Date = new Date()): Date {
  if (isNaN(date.getTime())) return date
  const mo = date.getUTCMonth()
  const day = date.getUTCDate()
  const dayNum = (y: number, m0: number, d: number) => y * 10000 + (m0 + 1) * 100 + d
  const dNum = dayNum(date.getUTCFullYear(), mo, day)
  const tNum = dayNum(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  if (dNum >= tNum) return date // already today-or-future — leave it

  // Past → next occurrence of this month/day that is today-or-later.
  let year = today.getUTCFullYear()
  if (dayNum(year, mo, day) < tNum) year++ // this year's occurrence already passed
  return new Date(Date.UTC(
    year, mo, day,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  ))
}
