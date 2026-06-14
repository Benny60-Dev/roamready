// Regression check for the packing-list regenerate carry-over
// (utils/packingMerge.ts). Run: npm run check:packing-merge (server/).
//
// Guards the two contract paths:
//   1. FRESH TRIP — no prior list (null) or nothing checked: the freshly
//      generated list must come back UNTOUCHED (the "empty 200" regression
//      suspect: intersecting against an empty prev must never empty next).
//   2. EXISTING CHECKS — the FULL regenerated list is returned with
//      previously-checked names re-checked (case-insensitive), new items
//      unchecked, and nothing filtered out.
import { mergePackedState } from '../src/utils/packingMerge'

let failed = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const freshList = [
  { category: 'Kitchen', items: [
    { name: 'Plates', required: true, checked: false },
    { name: 'Camp stove', required: true, checked: false },
  ]},
  { category: 'Outdoor', items: [
    { name: 'Camp chairs', required: false, checked: false },
  ]},
]

// 1. Fresh trip — prev null and prev [] both return next untouched (same reference).
check('fresh trip (prev=null): list untouched', mergePackedState(null, freshList) === freshList)
check('fresh trip (prev=[]): list untouched', mergePackedState([], freshList) === freshList)
check('fresh trip: nothing lost', mergePackedState(null, freshList).reduce((n, c) => n + c.items.length, 0) === 3)

// 2. Prior list with NO checks — still untouched.
const prevUnchecked = [{ category: 'Kitchen', items: [{ name: 'Plates', required: true, checked: false }] }]
check('prior list, nothing checked: untouched', mergePackedState(prevUnchecked, freshList) === freshList)

// 3. Existing checks — full new list back, matches re-checked, case-insensitive.
const prevWithChecks = [
  { category: 'Kitchen', items: [
    { name: 'PLATES  ', required: true, checked: true },     // case + whitespace
    { name: 'Old removed thing', required: false, checked: true },
  ]},
]
const merged = mergePackedState(prevWithChecks, freshList)
check('regenerate: every category survives', merged.length === 2)
check('regenerate: every item survives', merged.reduce((n, c) => n + c.items.length, 0) === 3)
check('regenerate: matching name re-checked (case-insensitive)', merged[0].items[0].checked === true)
check('regenerate: non-matching new items stay unchecked',
  merged[0].items[1].checked === false && merged[1].items[0].checked === false)
check('regenerate: previously-checked item ABSENT from new list is not resurrected',
  !merged.flatMap(c => c.items).some(i => i.name === 'Old removed thing'))
check('regenerate: input not mutated', freshList[0].items[0].checked === false)

// 4. Custom items — user-added items survive regenerate (they don't appear in
//    the freshly generated list), keeping their own checked state and category.
const prevWithCustom = [
  { category: 'Kitchen', items: [
    { name: 'Plates', required: true, checked: true },           // AI item, checked
    { name: 'Cast iron skillet', required: false, checked: true, custom: true },
  ]},
  { category: 'Dog', items: [
    { name: 'Tie-out stake', required: false, checked: false, custom: true },
  ]},
]
const mergedCustom = mergePackedState(prevWithCustom, freshList)
const allCustom = mergedCustom.flatMap((c: any) => c.items)
check('custom: user item appended into existing new-list category',
  mergedCustom.find((c: any) => c.category === 'Kitchen')?.items.some((i: any) => i.name === 'Cast iron skillet'))
check('custom: keeps its own checked state',
  allCustom.find((i: any) => i.name === 'Cast iron skillet')?.checked === true)
check('custom: category absent from new list is re-created',
  mergedCustom.find((c: any) => c.category === 'Dog')?.items.some((i: any) => i.name === 'Tie-out stake'))
check('custom: AI checked carry-over still applies alongside custom',
  mergedCustom.find((c: any) => c.category === 'Kitchen')?.items.find((i: any) => i.name === 'Plates')?.checked === true)
check('custom: input not mutated', freshList.length === 2)

// 5. DECISION 2 — nothing checked but a custom item exists: must NOT short-circuit.
const prevCustomNoChecks = [
  { category: 'Outdoor', items: [{ name: 'Hammock', required: false, checked: false, custom: true }] },
]
const mergedNoChecks = mergePackedState(prevCustomNoChecks, freshList)
check('custom-only (no checks): custom item preserved (no early-return drop)',
  mergedNoChecks.flatMap((c: any) => c.items).some((i: any) => i.name === 'Hammock'))

process.exit(failed ? 1 : 0)
