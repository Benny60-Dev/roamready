/**
 * RR69 regression coverage — the app-side guards built from the del-rio-nights
 * replay: the CALENDAR block (BUG-THIS-FRIDAY), the replay statesWeekday check,
 * the ReplayCase status lifecycle, and the underscore-safe tag strip.
 * Dependency-free assertion script (server convention):
 *
 *     npx tsx src/services/__tests__/rr69.test.ts        # from server/
 */
import { buildCalendarBlock } from '../ai'
import { firstStatedDate, nextStatusAfterRun } from '../replayRunner'

let failed = 0
const check = (label: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); if (!ok) failed++ }

// ── CALENDAR block: the app does the weekday math, in the user's timezone
const fri = new Date('2026-09-04T18:00:00Z')                 // Friday afternoon in Arizona
const cal = buildCalendarBlock(fri, 'America/Phoenix')
check('today is stated with its weekday', cal.includes('Today is Friday, September 4, 2026'))
check('next Friday is listed 7 days out', /\+7 days: Friday, September 11, 2026/.test(cal))
check('Sunday Sep 6 is labelled Sunday (the bug: "this Friday" → Sep 6)', /Sunday, September 6, 2026/.test(cal))
check('look-up-only rule present', /never compute a weekday yourself/.test(cal))
const lateUtc = new Date('2026-09-05T05:30:00Z')             // 10:30 PM Friday in Phoenix, already Saturday in UTC
check('user timezone wins over UTC date', buildCalendarBlock(lateUtc, 'America/Phoenix').includes('Today is Friday, September 4, 2026'))
check('bad timezone falls back without throwing', buildCalendarBlock(fri, 'Not/AZone').includes('Today is'))

// ── statesWeekday check helper
check('parses "September 6th, 2026" as a Sunday', firstStatedDate('leaving this Friday (September 6th, 2026)!')?.weekday === 'Sunday')
check('parses "Friday, September 11, 2026" as a Friday', firstStatedDate('Leaving Friday, September 11, 2026 from Mesa')?.weekday === 'Friday')
check('no full date → null', firstStatedDate('leaving this Friday') === null)

// ── ReplayCase lifecycle
check('OPEN + all pass → PASSING', nextStatusAfterRun('OPEN', 5, 5) === 'PASSING')
check('OPEN + 0/0 (no checks) stays OPEN', nextStatusAfterRun('OPEN', 0, 0) === undefined)
check('PASSING + a failure → OPEN (regression)', nextStatusAfterRun('PASSING', 4, 5) === 'OPEN')
check('FIXED never auto-moves', nextStatusAfterRun('FIXED', 0, 5) === undefined && nextStatusAfterRun('FIXED', 5, 5) === undefined)

// ── underscore-safe tag strip (the regex used in controllers/ai.ts)
const strip = (t: string) => t.replace(/<(?!\/?itinerary\b)([a-z_][a-zA-Z0-9_]*)>[\s\S]*?<\/\1>/g, '').replace(/<\/?(?!itinerary\b)[a-z_][a-zA-Z0-9_]*>/g, '')
check('<drive_cap> is stripped', !/drive_cap/.test(strip('ok?\n<drive_cap>8.5</drive_cap>')))
check('<itinerary> survives', /<itinerary>/.test(strip('x <itinerary>{"a":1}</itinerary> <origin>Mesa</origin>')) && !/origin/.test(strip('<origin>Mesa</origin>')))

// ── cap-consent "still asking" rule (mirrors controllers/ai.ts)
const stillAsking = (r: string) => /\?\s*$/.test(r.replace(/<[a-z_][a-zA-Z0-9_]*>[\s\S]*?<\/[a-z_][a-zA-Z0-9_]*>/g, '').trim())
check('a reply ending in a question (tag after it) is still asking', stillAsking('Are you good with 8.5-hour days?\n<drive_cap>8.5</drive_cap>'))
check('a statement is not asking', !stillAsking('Got it — 8.5-hour days it is.\n<drive_cap>8.5</drive_cap>'))

console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}`)
if (failed) process.exitCode = 1
