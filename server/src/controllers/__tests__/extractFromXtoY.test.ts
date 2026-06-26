/**
 * Regression coverage for extractFromXtoY (BUG-PLAN-ORIGIN-LOOP + pre-build budget).
 *
 * No test framework is wired in server/, so this is a self-contained, dependency-free
 * assertion script. Run it with:
 *
 *     npx tsx src/controllers/__tests__/extractFromXtoY.test.ts
 *
 * It imports the REAL function (not a copy) so the regexes under test never drift
 * from production. Exits non-zero on any mismatch.
 *
 * extractFromXtoY now returns { origin, dest } | null — origin feeds capturedOrigin
 * (anti origin-loop), dest feeds the deterministic destination capture that drives
 * the pre-build budget check. These cases lock in BOTH endpoints and the idiom
 * rejections (so the bare fallback never captures a non-route).
 */
import { extractFromXtoY } from '../ai'

type Case = { input: string; origin: string | null; dest: string | null; note: string }

const cases: Case[] = [
  // --- CAPTURES: keyword/arrow forms ---
  { input: 'from San Jose to Jacksonville 3 nights july7', origin: 'San Jose', dest: 'Jacksonville', note: 'from X to Y + run-together tail' },
  { input: 'to Bangor from KC 3 nights july7', origin: 'Kansas City', dest: 'Bangor', note: 'to Y from X + abbrev expand' },
  { input: 'KC -> Bangor 3 nights july7', origin: 'Kansas City', dest: 'Bangor', note: 'ASCII arrow + abbrev' },
  { input: 'KC → Bangor 3 nights july2', origin: 'Kansas City', dest: 'Bangor', note: 'unicode arrow + abbrev' },

  // --- CAPTURES: bare "X to Y" ---
  { input: 'San Jose to Jacksonville', origin: 'San Jose', dest: 'Jacksonville', note: 'bare route, no tail' },
  { input: 'Kansas City to Bangor 3 nights july7', origin: 'Kansas City', dest: 'Bangor', note: 'bare route, run-together date' },
  { input: 'Kansas City to Bangor, 3 nights july7', origin: 'Kansas City', dest: 'Bangor', note: 'bare route, comma before nights' },
  { input: 'Kansas City to Bangor 3 nights, july 7', origin: 'Kansas City', dest: 'Bangor', note: 'bare route, separated date' },

  // --- REJECTIONS: idioms / non-routes must return null ---
  { input: 'san jose to jacksonville', origin: null, dest: null, note: 'all-lowercase: no proper-noun signal' },
  { input: 'I want to go to Paris', origin: null, dest: null, note: 'mid-sentence idiom, not anchored at start' },
  { input: 'Take me to Paris next week', origin: null, dest: null, note: 'verb/pronoun opener (STOP: take)' },
  { input: 'going to Denver', origin: null, dest: null, note: 'verb opener (STOP: going)' },
  { input: 'We need to drive to Reno', origin: null, dest: null, note: 'no proper-noun origin before "to"' },
  { input: 'plan a trip to Miami', origin: null, dest: null, note: 'verb opener (STOP: plan)' },
  { input: 'Trip to Miami', origin: null, dest: null, note: 'destination-only false positive (STOP: trip)' },
]

let failures = 0
for (const c of cases) {
  const got = extractFromXtoY(c.input)
  const gotOrigin = got ? got.origin : null
  const gotDest = got ? got.dest : null
  const ok = gotOrigin === c.origin && gotDest === c.dest
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(c.input)}\n      expected origin=${JSON.stringify(c.origin)} dest=${JSON.stringify(c.dest)} | got origin=${JSON.stringify(gotOrigin)} dest=${JSON.stringify(gotDest)}  (${c.note})`,
  )
}

console.log(`\n${cases.length - failures}/${cases.length} passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
