/**
 * Regression coverage for buildTowedFields (RIGINFO-3 — shared towed-field save
 * logic previously hand-maintained across RigPage / EditRigPage / OnboardingPage).
 *
 * No test framework is wired into client/, so this mirrors the server's
 * self-contained, dependency-free assertion-script convention
 * (server/src/controllers/__tests__/extractFromXtoY.test.ts). Run it with:
 *
 *     npx tsx src/utils/__tests__/rigs.test.ts        # from client/
 *
 * It imports the REAL function (not a copy) so the direction logic under test
 * never drifts from production. Exits non-zero on any mismatch, and returns
 * naturally on success so the runner self-terminates (no orphaned tsx/node —
 * TEST-HARNESS-NOEXIT).
 */
import { buildTowedFields, type TowingChoice } from '../rigs'
import type { SecondVehicleDirection } from '../rigs'

// client/ has no @types/node (it's a browser bundle), but this script runs under
// tsx/node. Declare just the sliver of `process` we use so the app typecheck
// stays clean without dragging node types into the client build.
declare const process: { exit(code: number): never }

// A "fully populated" form-values object. Cases pick which fields should survive.
const FULL = {
  towedYear: 2020,
  towedMake: 'Ford',
  towedModel: 'F-250',
  towedLength: 22,
  towedLicensePlate: 'ABC-1234',
  towedHeight: 7,
  towedFuelType: 'Diesel',
}

type Expected = {
  isTowing: boolean
  towed: Record<string, unknown>
}

type Case = {
  note: string
  direction: SecondVehicleDirection
  towingChoice: TowingChoice
  data: Record<string, unknown>
  expected: Expected
}

const cleared = {
  towedType: null,
  towedYear: null,
  towedMake: null,
  towedModel: null,
  towedLength: null,
  towedLicensePlate: null,
  towedHeight: null,
  towedFuelType: null,
}

const cases: Case[] = [
  {
    note: 'tow_vehicle: always saves the truck incl. height + fuelType (required, choice ignored)',
    direction: 'tow_vehicle',
    towingChoice: 'VEHICLE',
    data: FULL,
    expected: {
      isTowing: true,
      towed: {
        towedType: 'VEHICLE',
        towedYear: 2020,
        towedMake: 'Ford',
        towedModel: 'F-250',
        towedLength: 22,
        towedLicensePlate: 'ABC-1234',
        towedHeight: 7,
        towedFuelType: 'Diesel',
      },
    },
  },
  {
    note: 'tow_vehicle: missing fields normalize to null',
    direction: 'tow_vehicle',
    towingChoice: 'VEHICLE',
    data: { towedLength: 18 },
    expected: {
      isTowing: true,
      towed: {
        towedType: 'VEHICLE',
        towedYear: null,
        towedMake: null,
        towedModel: null,
        towedLength: 18,
        towedLicensePlate: null,
        towedHeight: null,
        towedFuelType: null,
      },
    },
  },
  {
    note: 'toad + NONE: not towing, everything cleared',
    direction: 'toad',
    towingChoice: 'NONE',
    data: FULL,
    expected: { isTowing: false, towed: cleared },
  },
  {
    note: 'toad + VEHICLE: carries y/m/m + length + plate, height/fuel stay null',
    direction: 'toad',
    towingChoice: 'VEHICLE',
    data: FULL,
    expected: {
      isTowing: true,
      towed: {
        towedType: 'VEHICLE',
        towedYear: 2020,
        towedMake: 'Ford',
        towedModel: 'F-250',
        towedLength: 22,
        towedLicensePlate: 'ABC-1234',
        towedHeight: null,
        towedFuelType: null,
      },
    },
  },
  {
    note: 'toad + TRAILER: drops y/m/m, keeps length + plate, height/fuel null',
    direction: 'toad',
    towingChoice: 'TRAILER',
    data: FULL,
    expected: {
      isTowing: true,
      towed: {
        towedType: 'TRAILER',
        towedYear: null,
        towedMake: null,
        towedModel: null,
        towedLength: 22,
        towedLicensePlate: 'ABC-1234',
        towedHeight: null,
        towedFuelType: null,
      },
    },
  },
  {
    note: 'none: not towing, everything cleared',
    direction: 'none',
    towingChoice: 'NONE',
    data: FULL,
    expected: { isTowing: false, towed: cleared },
  },
]

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

let failures = 0
for (const c of cases) {
  const got = buildTowedFields(c.data, c.direction, c.towingChoice)
  const ok = got.isTowing === c.expected.isTowing && eq(got.towed, c.expected.towed)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.note}\n      expected ${JSON.stringify(c.expected)}\n      got      ${JSON.stringify(got)}`,
  )
}

console.log(`\n${cases.length - failures}/${cases.length} passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exit(1)
}
