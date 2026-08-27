// Google Large Vehicle Routing (LVR) test v2 — RoamReady bring-up.
//
// v2.1 (Aug 27): TRUCK runs now send routingPreference TRAFFIC_AWARE_OPTIMAL —
// required by Google once LVR is provisioned (400 INVALID_ARGUMENT otherwise).
//
// v2 changes: requests EVERY response field (field mask '*'), compares actual
// route geometry (polylines) between runs, adds an IMPOSSIBLE-vehicle run to
// prove whether vehicleInfo is applied or silently ignored, and writes the
// full raw responses to scripts/lvr-test-raw.json for Claude to inspect.
//
// Runs:
//   1. CAR              — normal drive routing (baseline)
//   2. RV               — travelMode TRUCK + the rig's real dimensions
//   3. RV + PROPANE     — same, plus hazardousGoodsTypes: GASES
//   4. IMPOSSIBLE TRUCK — 8 m tall, 100 t, 9 axles. NO road network can carry
//      this; if its route matches the car's, vehicleInfo is being IGNORED.
//
// Corridor: Great Neck, NY -> Hauppauge, NY (Northern State Pkwy = 7-8 ft
// stone bridges, trucks banned; the legal alternative is I-495).
//
// Reads GOOGLE_MAPS_API_KEY from the root .env.
// Run from repo root:  node scripts\google-lvr-test.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---------- rig profile (EDIT ME) ----------
const RIG = {
  totalHeightMm: 3988,   // 13'1" — coach height incl. roof gear
  totalWidthMm: 2591,    // 102" incl. mirrors
  totalLengthMm: 19400,  // ~63'8" — coach 40'10" + towbar + F-150
  totalWeightKg: 22800,  // ~50,300 lb — coach GVWR + F-150
  totalAxleCount: 5,     // 3 on the coach (tag axle) + 2 on the truck
  trailerInfo: [{ lengthMm: 5916 }], // the flat-towed F-150
}

const IMPOSSIBLE = {
  totalHeightMm: 8000,    // 26 ft tall
  totalWidthMm: 4000,     // 13 ft wide
  totalLengthMm: 40000,   // 131 ft long
  totalWeightKg: 100000,  // 220,000 lb
  totalAxleCount: 9,
}

const ORIGIN = 'Great Neck, NY'
const DESTINATION = 'Hauppauge, NY'
// -------------------------------------------

const scriptDir = dirname(fileURLToPath(import.meta.url))
const envPath = join(scriptDir, '..', '.env')
function readEnv(p) {
  const out = {}
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '')
  }
  return out
}
const API_KEY = readEnv(envPath).GOOGLE_MAPS_API_KEY
if (!API_KEY) { console.error('GOOGLE_MAPS_API_KEY not found in root .env'); process.exit(1) }

const raw = {} // full responses, saved to disk at the end

async function computeRoute(label, extraBody) {
  const body = {
    origin: { address: ORIGIN },
    destination: { address: DESTINATION },
    routingPreference: 'TRAFFIC_AWARE',
    ...extraBody,
  }
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': '*', // everything — we're hunting for truck fields
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  raw[label] = { request: body, httpStatus: res.status, response: safeParse(text) }
  if (!res.ok) {
    console.log(`\n=== ${label} — HTTP ${res.status} ===`)
    console.log(text.slice(0, 2000))
    return null
  }
  const data = JSON.parse(text)
  const r = data.routes?.[0]
  if (!r) { console.log(`\n=== ${label} === no route returned`); return null }
  const miles = (r.distanceMeters / 1609.34).toFixed(1)
  const mins = Math.round(parseInt(r.duration) / 60)
  console.log(`\n=== ${label} ===`)
  console.log(`  Route:    ${r.description ?? '(no description)'}`)
  console.log(`  Distance: ${miles} mi   Drive time: ${mins} min`)
  if (r.warnings?.length) console.log(`  Warnings: ${r.warnings.join(' | ')}`)
  // surface ANY field that looks truck/restriction-related, wherever it lives
  const hits = findKeys(r, /restrict|truck|vehicle|ignored|violat/i)
  if (hits.length) console.log(`  Truck-related fields: ${hits.join('; ')}`)
  return r
}

function safeParse(t) { try { return JSON.parse(t) } catch { return t } }

function findKeys(obj, re, path = '', out = []) {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k
      if (re.test(k)) out.push(`${p}=${JSON.stringify(v)}`)
      if (v && typeof v === 'object' && out.length < 20) findKeys(v, re, p, out)
    }
  }
  return out
}

const geom = (r) => r?.polyline?.encodedPolyline ?? r?.legs?.[0]?.polyline?.encodedPolyline ?? ''

console.log(`LVR test v2: ${ORIGIN} -> ${DESTINATION}`)

const car = await computeRoute('1. CAR (baseline)', { travelMode: 'DRIVE' })
const rv = await computeRoute('2. RV (TRUCK + dimensions)', {
  travelMode: 'TRUCK',
  routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
  routeModifiers: { vehicleInfo: RIG },
})
const rvLp = await computeRoute('3. RV + PROPANE (GASES)', {
  travelMode: 'TRUCK',
  routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
  routeModifiers: { vehicleInfo: { ...RIG, hazardousGoodsTypes: ['GASES'] } },
})
const mega = await computeRoute('4. IMPOSSIBLE TRUCK (26 ft tall, 220k lb)', {
  travelMode: 'TRUCK',
  routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
  routeModifiers: { vehicleInfo: IMPOSSIBLE },
})

const outPath = join(scriptDir, 'lvr-test-raw.json')
writeFileSync(outPath, JSON.stringify(raw, null, 2))
console.log(`\nFull raw responses written to: ${outPath}`)

console.log('\n================ VERDICT ================')
if (!rv) {
  console.log('TRUCK mode errored — see above. Paste this output to Claude.')
} else if (car && geom(car) && geom(car) === geom(rv) && geom(rv) === geom(mega ?? rv)) {
  console.log('IGNORED: the car, your RV, and a 26-FOOT-TALL 220,000-LB truck all')
  console.log('got IDENTICAL route geometry. Google is not applying vehicleInfo —')
  console.log('this project is almost certainly not provisioned for LVR yet.')
} else if (car && geom(car) === geom(rv)) {
  console.log('PARTIAL: your RV matched the car route, but the impossible truck')
  console.log('was routed differently — attributes ARE applied; this corridor may')
  console.log('genuinely allow your rig, or thresholds differ. Needs a closer look.')
} else {
  console.log('PASS: the RV got different route geometry than the car.')
  console.log(`  Car: ${car?.description}`)
  console.log(`  RV:  ${rv.description}`)
}
console.log('\nPaste this entire output back to Claude for analysis.')
