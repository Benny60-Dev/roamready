import { format as dfFormat } from 'date-fns'

/**
 * Calendar-date helpers for trip/stop dates.
 *
 * ──────────────────────────── THE BUG ────────────────────────────
 * Trip and stop dates are stored as UTC midnight timestamps (the AI emits
 * "2026-07-10T00:00:00Z" when it means "July 10"). The frontend used to
 * render them with `new Date(s)` + local accessors:
 *
 *   format(new Date("2026-07-10T00:00:00Z"), 'MMM d')
 *
 * In any negative-offset timezone (Phoenix MST, all of US/Canada), the
 * JS Date constructor interprets the UTC instant in local time, shifting
 * July 10 00:00 UTC → July 9 17:00 local → format outputs "Jul 9".
 *
 * Cindy hit this after asking the AI to shift her trip to July 10 — the
 * shift succeeded, the DB stored "2026-07-10", but every screen showed
 * "Jul 9". Same root cause affected every date display across the app,
 * not just the modify flow.
 *
 * ──────────────────────────── THE FIX ────────────────────────────
 * parseTripDate extracts the UTC y/m/d from the input and constructs a
 * Date with those components as LOCAL noon. Local-time accessors
 * (getDate/getMonth/getFullYear, date-fns format) then return the UTC
 * calendar day — which is what the user intended, regardless of viewer TZ.
 *
 * Noon (not midnight) avoids the once-a-year DST edge case where local
 * midnight doesn't exist (spring-forward gaps).
 *
 * ─────────────────────────── WHY NOT @db.Date ───────────────────────────
 * The architecturally-correct fix is Postgres DATE columns + a server
 * serialization layer that emits "YYYY-MM-DD" wire strings. We chose this
 * frontend-only path instead because (a) Prisma 6 still returns Date
 * objects for @db.Date so the schema change alone doesn't fix the bug,
 * (b) no multi-timezone users exist yet — single-app, local DB. The
 * deeper migration is filed as backlog (Path 1 from the May-19 scout).
 */

/**
 * Parse a date-shaped value from the API (or anywhere) into a Date whose
 * LOCAL-time accessors return the UTC calendar day.
 *
 * Accepts:
 *   - ISO timestamp string: "2026-07-10T00:00:00.000Z" or "2026-07-10T00:00:00"
 *   - YYYY-MM-DD string: "2026-07-10"
 *   - Date instance (whose UTC components are used)
 *   - null / undefined (passes through as null)
 *
 * Returns a Date set to LOCAL noon on the extracted calendar day, or null.
 *
 * Use this for any date-fns format() / addDays() / day-math, OR pull
 * .getDate() / .getMonth() / .getFullYear() from the result and they'll
 * match the original UTC date string regardless of the viewer's timezone.
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
 * Format a trip/stop date as a human-readable string using date-fns format
 * tokens (e.g. "EEE MMM d", "MMM d, yyyy"). The output reflects the UTC
 * calendar day regardless of viewer timezone — sidesteps the Phoenix
 * off-by-one bug for every renderer in one call.
 *
 * Returns "" for null/undefined/invalid input so JSX templating stays
 * straightforward (no `&&` guards needed for empty render).
 */
export function formatTripDate(
  value: string | Date | null | undefined,
  formatStr: string,
): string {
  const d = parseTripDate(value)
  if (!d) return ''
  return dfFormat(d, formatStr)
}

/**
 * Short lifecycle date for created/edited timestamps: "Jun 11" within the
 * current year, "Jun 11, 2025" otherwise. Takes a full ISO timestamp
 * (Trip.createdAt) — NOT a date-only wire string, so plain `new Date` is
 * correct here (no parseTripDate local-noon normalization needed).
 */
export function lifecycleDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return dfFormat(d, sameYear ? 'MMM d' : 'MMM d, yyyy')
}

/**
 * Format a Date as a YYYY-MM-DD wire string using LOCAL calendar components.
 * Inverse of parseTripDate for the write path — the date the user sees on
 * screen round-trips to the date that gets stored. Prisma's z.coerce.date()
 * will accept "2026-07-10" and convert it to a Date at UTC midnight on
 * that calendar day, matching the rest of the storage convention.
 */
export function toYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * PAST-TRAVEL-DATE BACKSTOP (client mirror of server util rollDateForwardIfPast).
 *
 * Rolls a yearless date the planner mis-resolved to the PAST forward to the next
 * future occurrence of the same month/day ("2025-07-29" with today 2026-06-29 →
 * "2026-07-29"). A date already today-or-later is returned unchanged with
 * rolled=false. Surfaced in the planning chat so the user sees the correction;
 * the server (promoteSession) is the authoritative guarantee.
 *
 * Pure string/integer math on the leading YYYY-MM-DD (so a bare date or a full
 * ISO timestamp both work) — no Date arithmetic, no timezone pitfalls. `today`
 * is compared via its LOCAL calendar day (the user's sense of "today").
 */
export function rollYmdForwardIfPast(
  value: string,
  today: Date = new Date(),
): { date: string; rolled: boolean } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return { date: value, rolled: false }
  const Y = Number(m[1]), M = Number(m[2]), D = Number(m[3])
  const dayNum = (y: number, mo: number, d: number) => y * 10000 + mo * 100 + d
  const tNum = dayNum(today.getFullYear(), today.getMonth() + 1, today.getDate())
  if (dayNum(Y, M, D) >= tNum) return { date: value, rolled: false }

  let year = today.getFullYear()
  if (dayNum(year, M, D) < tNum) year++ // this year's occurrence already passed
  const pad = (n: number) => String(n).padStart(2, '0')
  return { date: `${year}-${pad(M)}-${pad(D)}`, rolled: true }
}

/**
 * Format an ISO timestamp as a relative time string ("5 minutes ago" / "2d ago").
 *
 * Replaces three byte-near-identical inline copies that had drifted into
 * SessionPage, SessionNewPage, and SessionsPanel — see Block 3a for the
 * extraction. The verbose form is the canonical "X ago" copy the rest of
 * the app uses; the compact form (opts.short=true) collapses the labels
 * down for crowded card meta rows (used by Block 3b's Dashboard cards).
 *
 *   verbose (default):   "just now" / "5 minutes ago" / "3 hours ago" /
 *                        "yesterday" / "4 days ago" / "May 6"
 *   short (compact):     "now"      / "5m ago"       / "3h ago"      /
 *                        "1d ago"   / "4d ago"       / "May 6"
 *
 * The >7-day fallback ("MMM d") matches in both modes — once a trip is
 * more than a week old there's no value in fuzzy time, an absolute date
 * is more useful.
 */
export function relativeTime(iso: string, opts?: { short?: boolean }): string {
  const short = opts?.short === true
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return short ? 'now' : 'just now'
  if (diff < hour) {
    const m = Math.floor(diff / minute)
    return short ? `${m}m ago` : `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (diff < day) {
    const h = Math.floor(diff / hour)
    return short ? `${h}h ago` : `${h} hour${h === 1 ? '' : 's'} ago`
  }
  if (diff < 2 * day) return short ? '1d ago' : 'yesterday'
  if (diff < 7 * day) {
    const d = Math.floor(diff / day)
    return short ? `${d}d ago` : `${d} days ago`
  }
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
