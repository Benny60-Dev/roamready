// Shared option lists for the rig data-entry dropdowns (RangeSelect). Single
// source of truth — replaces the YEARS arrays that were copy-pasted inline in
// RigPage.tsx and EditRigPage.tsx, and gives OnboardingPage real dropdowns
// (fixing the bare-number-input "click up from 0" year regression).
//
// Backend types (prisma Rig): year/towedYear are Int?; length/height/mpg/
// mpgTowing/tankSize/garageLength/towedLength/towedHeight are Float?. RangeSelect
// always emits a number (or undefined when empty), so these serialize correctly.

/** Build an inclusive [start, end] numeric range at `step`, rounding each value
 *  to one decimal to avoid float drift (e.g. 10 + 0.5*N landing on 10.4999…). */
function buildRange(start: number, end: number, step: number): number[] {
  const out: number[] = []
  const count = Math.round((end - start) / step)
  for (let i = 0; i <= count; i++) {
    out.push(Math.round((start + i * step) * 10) / 10)
  }
  return out
}

// Newest first: next model year (current + 1) down to 1990. Whole years (Int?).
const YEAR_MAX = new Date().getFullYear() + 1
export const YEARS: number[] = Array.from(
  { length: YEAR_MAX - 1990 + 1 },
  (_, i) => YEAR_MAX - i,
)

// Feet, 0.5-ft steps (Float?).
export const LENGTHS: number[] = buildRange(10, 65, 0.5)
export const HEIGHTS: number[] = buildRange(8, 14, 0.5)

// Whole numbers, emitted as `number` (the columns are Float? but accept ints).
export const MPG_OPTIONS: number[] = buildRange(5, 30, 1)
export const TANK_OPTIONS: number[] = buildRange(10, 200, 5)
