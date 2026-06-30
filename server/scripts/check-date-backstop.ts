// Regression check for the past-travel-date backstop (utils/dates.ts
// rollDateForwardIfPast). Run: npm run check:date-backstop (server/).
//
// Pure-unit — no DB, no running server. Asserts a yearless date the planner
// mis-resolved to the PAST is rolled forward to the next FUTURE occurrence of
// the same month/day, and that a today-or-future date is left untouched.
//
// `today` is injected so the assertions don't depend on the system clock.
import { rollDateForwardIfPast } from '../src/utils/dates'

let failed = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// Build a UTC-midnight date (the storage shape) from y/m/d (m is 1-based here).
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
// Render a result's UTC calendar day as YYYY-MM-DD for readable assertions.
const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

// Today is fixed at 2026-06-29 for every case below.
const TODAY = utc(2026, 6, 29)

// 1. The exact bug: anchor 2025-07-29 with today in 2026 → 2026-07-29 (not past).
check('bug case: 2025-07-29 → 2026-07-29',
  ymd(rollDateForwardIfPast(utc(2025, 7, 29), TODAY)) === '2026-07-29',
  ymd(rollDateForwardIfPast(utc(2025, 7, 29), TODAY)))

// 2. A yearless month/day still ahead THIS year stays this year (July 29 > June 29).
check('future this year stays this year: 2026-07-29 unchanged',
  ymd(rollDateForwardIfPast(utc(2026, 7, 29), TODAY)) === '2026-07-29')

// 3. A month/day EARLIER this year rolls to next year (March 15 already passed).
check('earlier this year rolls to next year: 2026-03-15 → 2027-03-15',
  ymd(rollDateForwardIfPast(utc(2026, 3, 15), TODAY)) === '2027-03-15')

// 4. Exactly today is today-or-later → unchanged (inclusive boundary).
check('today stays today: 2026-06-29 unchanged',
  ymd(rollDateForwardIfPast(utc(2026, 6, 29), TODAY)) === '2026-06-29')

// 5. A genuinely future date (later year) is left completely alone.
check('future year unchanged: 2027-01-01 stays',
  ymd(rollDateForwardIfPast(utc(2027, 1, 1), TODAY)) === '2027-01-01')

// 6. A past date EARLIER this year, several months back → next year.
check('past earlier this year: 2026-01-10 → 2027-01-10',
  ymd(rollDateForwardIfPast(utc(2026, 1, 10), TODAY)) === '2027-01-10')

// 7. A multi-year-past date rolls to the NEXT future occurrence, never the past.
check('multi-year past: 2023-12-25 → 2026-12-25',
  ymd(rollDateForwardIfPast(utc(2023, 12, 25), TODAY)) === '2026-12-25')

// 8. Never returns a date before today, for any of a year's month/days.
let anyPast = false
for (let m = 1; m <= 12; m++) {
  const r = rollDateForwardIfPast(utc(2025, m, 15), TODAY)
  const rNum = r.getUTCFullYear() * 10000 + (r.getUTCMonth() + 1) * 100 + r.getUTCDate()
  if (rNum < 2026_06_29) anyPast = true
}
check('sweep: no rolled date lands before today', !anyPast)

// 9. UTC time-of-day is preserved (stored dates stay UTC-midnight).
const rolled = rollDateForwardIfPast(new Date(Date.UTC(2025, 6, 29, 0, 0, 0)), TODAY)
check('preserves UTC midnight', rolled.getUTCHours() === 0 && rolled.getUTCMinutes() === 0)

process.exit(failed ? 1 : 0)
