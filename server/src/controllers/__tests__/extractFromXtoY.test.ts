/**
 * Regression coverage for extractFromXtoY (BUG-PLAN-ORIGIN-LOOP).
 *
 * No test framework is wired in server/, so this is a self-contained, dependency-free
 * assertion script. Run it with:
 *
 *     npx tsx src/controllers/__tests__/extractFromXtoY.test.ts
 *
 * It imports the REAL function (not a copy) so the regexes under test never drift
 * from production. Exits non-zero on any mismatch.
 *
 * The bug: clean route openers with NO "from"/arrow keyword — "Kansas City to
 * Bangor 3 nights july7" — were missed by the deterministic origin parser, so the
 * planner re-asked for an origin the user had already given. The run-together date
 * tail ("july7") was a RED HERRING: "San Jose to Jacksonville" failed with no tail
 * at all. The real gap was the bare "X to Y" form. These cases lock in the fix and
 * guard the idiom rejections (so the bare fallback never captures a non-route).
 */
import { extractFromXtoY } from '../ai'

type Case = { input: string; expected: string | null; note: string }

const cases: Case[] = [
  // --- CAPTURES: keyword/arrow forms (pre-existing, kept green) ---
  { input: 'from San Jose to Jacksonville 3 nights july7', expected: 'San Jose', note: 'from X to Y + run-together tail' },
  { input: 'to Bangor from KC 3 nights july7', expected: 'Kansas City', note: 'to Y from X + abbrev expand' },
  { input: 'KC -> Bangor 3 nights july7', expected: 'Kansas City', note: 'ASCII arrow + abbrev' },
  { input: 'KC → Bangor 3 nights july2', expected: 'Kansas City', note: 'unicode arrow + abbrev' },

  // --- CAPTURES: NEW bare "X to Y" fallback (the fix) ---
  { input: 'San Jose to Jacksonville', expected: 'San Jose', note: 'bare route, no tail' },
  { input: 'Kansas City to Bangor 3 nights july7', expected: 'Kansas City', note: 'bare route, run-together date' },
  { input: 'Kansas City to Bangor, 3 nights july7', expected: 'Kansas City', note: 'bare route, comma before nights' },
  { input: 'Kansas City to Bangor 3 nights, july 7', expected: 'Kansas City', note: 'bare route, separated date' },

  // --- REJECTIONS: idioms / non-routes must return null ---
  { input: 'san jose to jacksonville', expected: null, note: 'all-lowercase: no proper-noun signal (LLM tag handles)' },
  { input: 'I want to go to Paris', expected: null, note: 'mid-sentence idiom, not anchored at start' },
  { input: 'Take me to Paris next week', expected: null, note: 'verb/pronoun opener (STOP: take)' },
  { input: 'going to Denver', expected: null, note: 'verb opener (STOP: going)' },
  { input: 'We need to drive to Reno', expected: null, note: 'no proper-noun origin before "to"' },
  { input: 'plan a trip to Miami', expected: null, note: 'verb opener (STOP: plan)' },
  { input: 'Trip to Miami', expected: null, note: 'destination-only false positive (STOP: trip)' },
]

let failures = 0
for (const c of cases) {
  const got = extractFromXtoY(c.input)
  const ok = got === c.expected
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(c.input)}\n      expected=${JSON.stringify(c.expected)} got=${JSON.stringify(got)}  (${c.note})`,
  )
}

console.log(`\n${cases.length - failures}/${cases.length} passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
