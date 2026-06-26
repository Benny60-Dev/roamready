/**
 * Determinism check for the PRE-BUILD budget path (BUG-MILEAGE-OPENING-TURN).
 *
 * Run: npx tsx --env-file=../.env src/controllers/__tests__/prebuildBudget.determinism.ts
 *
 * Simulates the opening "Kansas City to Bangor, 3 nights" turn 5× through the REAL
 * deterministic pipeline the controller uses — extractFromXtoY (dest) →
 * hasRoundTripIntent (shape) → synthetic name-stops → minimalTripBudget (minNeeded).
 * All 5 runs MUST yield the identical minNeeded — the guarantee prompts could not
 * give. Also runs the "and back" variant to prove the ×2 shape is stable + distinct.
 */
import { extractFromXtoY } from '../ai'
import { hasRoundTripIntent } from '../../utils/roundTripIntent'
import { minimalTripBudget } from '../trips'

const KEY = process.env.GOOGLE_MAPS_API_KEY ?? ''
const CAP_HOURS = 8 // fixed cap for the harness (deterministic from profile in prod)
const REQ_NIGHTS = 3

async function computeOnce(userMsg: string): Promise<{ shape: string; minNeeded: number | null }> {
  const route = extractFromXtoY(userMsg)
  if (!route) throw new Error('route parse failed')
  const roundTrip = hasRoundTripIntent([userMsg], [route.origin])
  const home = { locationName: route.origin, type: 'HOME', nights: 0 }
  const dest = { locationName: route.dest, type: 'DESTINATION', nights: REQ_NIGHTS }
  const synthetic = roundTrip
    ? [home, dest, { locationName: route.origin, type: 'DESTINATION', nights: 0 }]
    : [home, dest]
  const conflict = await minimalTripBudget(synthetic as any, CAP_HOURS, REQ_NIGHTS, KEY)
  return { shape: roundTrip ? 'ROUND_TRIP' : 'ONE_WAY', minNeeded: conflict?.minNeeded ?? null }
}

async function run(label: string, userMsg: string): Promise<number | null> {
  const results: Array<{ shape: string; minNeeded: number | null }> = []
  for (let i = 0; i < 5; i++) results.push(await computeOnce(userMsg))
  const minNeededs = results.map(r => r.minNeeded)
  const shapes = results.map(r => r.shape)
  const allSame = minNeededs.every(v => v === minNeededs[0]) && shapes.every(s => s === shapes[0])
  console.log(`\n[${label}] ${JSON.stringify(userMsg)}`)
  console.log(`  shape   (5 runs): ${shapes.join(', ')}`)
  console.log(`  minNeeded (5 runs): ${minNeededs.map(v => v ?? 'null').join(', ')}`)
  console.log(`  ${allSame ? 'PASS — identical across all 5 runs' : 'FAIL — non-deterministic'}`)
  if (!allSame) process.exitCode = 1
  return minNeededs[0]
}

;(async () => {
  if (!KEY) {
    console.error('GOOGLE_MAPS_API_KEY not loaded — re-run with: npx tsx --env-file=../.env <file>')
    process.exit(2)
  }
  const oneWay = await run('one-way', 'Kansas City to Bangor, 3 nights')
  const roundTrip = await run('round-trip', 'Kansas City to Bangor and back, 3 nights')
  console.log(`\nCross-check: one-way minNeeded=${oneWay}, round-trip minNeeded=${roundTrip} ` +
    `(round-trip should be >= one-way via the ×2 shape multiplier)`)
})()
