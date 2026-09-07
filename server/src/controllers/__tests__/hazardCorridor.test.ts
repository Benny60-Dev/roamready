/**
 * PR-7 regression — hazards match the MEASURED route, not a 25-mile band around
 * a straight line. Moki Dugway (UT-261) must stay silent on a US-160 → US-191
 * drive (Kayenta → Blanding) and fire on a drive that actually climbs it
 * (Mexican Hat → Natural Bridges). Prisma is stubbed to the one hazard row.
 *
 *     npx tsx src/controllers/__tests__/hazardCorridor.test.ts    # from server/
 */
;(globalThis as any).__prismaStub = {
  hazard: { findMany: async () => [{
    name: 'Moki Dugway', state: 'UT', lat: 37.2730, lng: -109.9270, hazardType: 'GRADE',
    maxLengthFt: null, maxHeightFt: null, maxWidthFt: null, maxWeightLbs: null, gradePct: 10, propaneBanned: false, roadDesignation: 'UT-261',
  }] },
}
const { detectStopHazards } = await import('../trips')

let failed = 0
const check = (label: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); if (!ok) failed++ }
const rig: any = { length: 41, height: 13, gvwr: 46000, vehicleType: 'RV_CLASS_A' }
const seg = (a: [number, number], b: [number, number]) => ({ durationSec: 0, startLat: a[0], startLng: a[1], endLat: b[0], endLng: b[1] })

// US-160 east from Kayenta to Mexican Water, then US-191 north via Bluff to Blanding — never on UT-261.
const kayenta = { locationName: 'Kayenta', locationState: 'AZ', latitude: 36.7278, longitude: -110.2545 }
const blanding = { locationName: 'Blanding', locationState: 'UT', latitude: 37.6244, longitude: -109.4784 }
const us160_191 = [seg([36.7278, -110.2545], [36.95, -109.65]), seg([36.95, -109.65], [37.2842, -109.5518]), seg([37.2842, -109.5518], [37.6244, -109.4784])]
const a = [{ ...kayenta }, { ...blanding }]
const r1 = await detectStopHazards(a, rig, '', [{ from: 'Kayenta', to: 'Blanding', steps: us160_191 }])
check('Kayenta → Blanding on US-160/US-191: Moki Dugway does NOT fire', r1.hitCount === 0, `hits ${r1.hitCount}`)

// Mexican Hat → Natural Bridges via UT-261 — the road goes right over the Dugway.
const mexHat = { locationName: 'Mexican Hat', locationState: 'UT', latitude: 37.1519, longitude: -109.8680 }
const bridges = { locationName: 'Natural Bridges', locationState: 'UT', latitude: 37.6014, longitude: -109.9757 }
const ut261 = [seg([37.1519, -109.8680], [37.2730, -109.9270]), seg([37.2730, -109.9270], [37.6014, -109.9757])]
const b = [{ ...mexHat }, { ...bridges }]
const r2 = await detectStopHazards(b, rig, '', [{ from: 'Mexican Hat', to: 'Natural Bridges', steps: ut261 }])
check('Mexican Hat → Natural Bridges via UT-261: Moki Dugway fires', r2.hitCount === 1, `hits ${r2.hitCount}`)
check('the note lands on the arriving stop', Array.isArray((b[1] as any).violationNotes) && (b[1] as any).violationNotes.length === 1)

// No geometry → NO corridor test (PLANNER-HAZARD-CORRIDOR). The 25-mile band
// used to put Moki inside it (and Apache Trail on every trip out of Mesa);
// now a leg without measured geometry only name-matches.
const c = [{ ...kayenta }, { ...blanding }]
const r3 = await detectStopHazards(c, rig, '', [])
check('no geometry → corridor skipped, nothing fires', r3.hitCount === 0, `hits ${r3.hitCount}`)

// A stop that already carries the same note (a rebuilt itinerary) does not get it twice.
const d = [{ ...mexHat }, { ...bridges, violationNotes: [((b[1] as any).violationNotes as string[])[0]] }]
await detectStopHazards(d, rig, '', [{ from: 'Mexican Hat', to: 'Natural Bridges', steps: ut261 }])
check('re-detection does not duplicate an existing note', (d[1] as any).violationNotes.length === 1, `${(d[1] as any).violationNotes.length} note(s)`)

console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}`)
if (failed) process.exitCode = 1
