/**
 * RR69 regression coverage — PR-6 transit-night pricing (effectiveSiteRate /
 * computeTripTotals) and RIG-DIMS-REQUIRED (missingSafetyDims car-camping
 * exemption). Same dependency-free convention as rigs.test.ts:
 *
 *     npx tsx src/utils/__tests__/rr69.test.ts        # from client/
 */
import { effectiveSiteRate, computeTripTotals, DEFAULT_SITE_RATE } from '../tripTotals'
import { missingSafetyDims } from '../rigs'

declare const process: { exitCode?: number }
let failed = 0
const check = (label: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); if (!ok) failed++ }

// ── PR-6: an unpriced overnight uses the trip's average rate, else the default
const stops = [
  { order: 1, nights: 0, siteRate: null },                 // HOME
  { order: 2, nights: 1, siteRate: null, type: 'OVERNIGHT_ONLY' }, // Tonalea (engine-inserted)
  { order: 3, nights: 5, siteRate: 75 },                   // Moab
]
const eff = effectiveSiteRate(stops[1], stops)
check('transit night priced at the average of other priced stops', eff.rate === 75 && eff.estimated === true, JSON.stringify(eff))
check('home (0 nights) prices at 0', effectiveSiteRate(stops[0], stops).rate === 0)
check('own siteRate wins and is not flagged estimated', effectiveSiteRate(stops[2], stops).rate === 75 && effectiveSiteRate(stops[2], stops).estimated === false)
const lonely = [{ order: 1, nights: 0 }, { order: 2, nights: 1, type: 'OVERNIGHT_ONLY' }]
check(`no priced stops → DEFAULT_SITE_RATE ($${DEFAULT_SITE_RATE})`, effectiveSiteRate(lonely[1], lonely).rate === DEFAULT_SITE_RATE)
const totals = computeTripTotals({ stops } as any, { fuelEstimate: 100 })
check('6-night trip bills 6 nights (5×75 + 1×75 + fuel 100 = 550)', Math.round(totals.plannedTotal) === 550, `planned ${totals.plannedTotal}`)

// ── RIG-DIMS-REQUIRED: what counts as incomplete
check('Thor with no GVWR is missing weight only', JSON.stringify(missingSafetyDims({ length: 38, height: 13, gvwr: null })) === '["gvwr"]')
check('complete rig missing nothing', missingSafetyDims({ length: 41, height: 13, gvwr: 46000 }).length === 0)
check('CAR_CAMPING is exempt even with nothing filled', missingSafetyDims({ vehicleType: 'CAR_CAMPING' }).length === 0)
check('VAN is NOT exempt', missingSafetyDims({ vehicleType: 'VAN' }).length === 3)

console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}`)
if (failed) process.exitCode = 1
