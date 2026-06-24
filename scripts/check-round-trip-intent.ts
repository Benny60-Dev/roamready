// Regression check for round-trip intent detection (client/src/utils/
// roundTripIntent.ts). Run: npm run check:round-trip-intent (repo root;
// Node ≥23.6 runs erasable TS natively). Mirrors check-packing-merge.
import { hasRoundTripIntent } from '../client/src/utils/roundTripIntent.ts'

let failed = 0
const check = (name: string, ok: boolean) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

type Case = [name: string, messages: string[], origins: (string | null)[], expectRoundTrip: boolean]
const cases: Case[] = [
  // ── keep return leg (round-trip intent) ──
  ['classic "round trip"', ['plan a round trip to Moab'], [], true],
  ['hyphenated "round-trip"', ['a round-trip from Denver'], [], true],
  ['the prod regression: "and back"', ['plan a trip from mesa to new york and back, 6 hour drive days'], [], true],
  ['"there and back"', ['Yellowstone, there and back'], [], true],
  ['"return" / "returning"', ['include the return drive please'], [], true],
  ['"back home"', ['then head back home'], [], true],
  ['"back to <profile homeCity>"', ['then back to Mesa'], ['Mesa'], true],
  ['"back to <itinerary HOME stop w/ state>"', ['and then back to mesa at the end'], ['Mesa, AZ'], true],
  ['"back to <origin stated in first message>" (no profile)', ['from mesa to NYC', 'ok now back to mesa too'], [null], true],
  ['multi-message: phrase in later message', ['trip to Zion', 'make it a round trip'], [], true],
  // AI-RT-2 — natural-language return variants the old exact-phrase list missed.
  ['the RR49 regression: "come home"', ['round rock texas july 5th for 6 days and come home'], [], true],
  ['"head back home"', ['then head back home to mesa'], [], true],
  ['"loop trip"', ['a loop trip through the rockies'], [], true],

  // ── strip return leg (one-way) ──
  ['plain one-way ask', ['plan a trip from Phoenix to Portland'], [], false],
  ['plain destination ask stays one-way', ['plan me a trip to Denver, 4 days'], [], false],
  ['"backpacking" must not match "back"-phrases', ['a backpacking trip to the Sierras'], [], false],
  ['"back to <other city>" (not an origin)', ['from mesa to denver, then back to salt lake'], [null], false],
  ['no messages', [], ['Mesa'], false],
]

for (const [name, messages, origins, expect] of cases) {
  check(name, hasRoundTripIntent(messages, origins) === expect)
}

process.exit(failed ? 1 : 0)
