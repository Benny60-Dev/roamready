import { VehicleType, TowedType } from '../types'

/**
 * Derive the relationship between a rig and its (optional or required) second
 * vehicle directly from vehicleType.
 *
 * Block 7 generalizes the existing toad-only towing fields on the Rig model
 * to also represent the TOW VEHICLE direction (truck in front of a 5th wheel,
 * trailer, etc.). Direction is NEVER stored — it's always computed from
 * vehicleType so there's exactly one source of truth and no "what if they
 * disagree" edge case.
 *
 *   - 'toad'        : second vehicle is BEHIND the rig (towed). Optional —
 *                     Block 8 should ask "are you bringing the [toad]?" per
 *                     trip, since some weekends you leave the Jeep home.
 *   - 'tow_vehicle' : second vehicle is IN FRONT of the rig (pulling it).
 *                     Required — the trailer literally can't move without it,
 *                     so Block 8 auto-includes it without asking.
 *   - 'none'        : rig has no second-vehicle concept (vans, car camping).
 *                     UI hides the second-vehicle section entirely.
 *
 * TOY_HAULER is treated as tow_vehicle direction (trailer-style toy hauler),
 * matching the existing UI's implicit assumption. Class A toy hauler users
 * — rare cohort — should classify as RV_CLASS_A with isToyHauler:true.
 */

export type SecondVehicleDirection = 'toad' | 'tow_vehicle' | 'none'

export interface SecondVehicleSpec {
  direction: SecondVehicleDirection
  /** Required = trailer needs the prime mover to move at all. Block 8 reads
   *  this to decide between auto-include vs ask-the-user-per-trip. */
  required: boolean
}

const DIRECTION_BY_VEHICLE_TYPE: Record<VehicleType, SecondVehicleSpec> = {
  // Motorhomes — the rig is the prime mover; an optional toad goes behind.
  RV_CLASS_A:     { direction: 'toad',        required: false },
  RV_CLASS_B:     { direction: 'toad',        required: false },
  RV_CLASS_C:     { direction: 'toad',        required: false },
  // Trailers — the rig is the towed unit; a tow vehicle goes in front, required.
  FIFTH_WHEEL:    { direction: 'tow_vehicle', required: true  },
  TRAVEL_TRAILER: { direction: 'tow_vehicle', required: true  },
  POP_UP:         { direction: 'tow_vehicle', required: true  },
  TOY_HAULER:     { direction: 'tow_vehicle', required: true  },
  // No prime-mover relationship. Vans rarely tow; car camping isn't a rig.
  VAN:            { direction: 'none',        required: false },
  CAR_CAMPING:    { direction: 'none',        required: false },
}

export function deriveSecondVehicle(vehicleType: VehicleType | undefined | null): SecondVehicleSpec {
  if (!vehicleType) return { direction: 'none', required: false }
  return DIRECTION_BY_VEHICLE_TYPE[vehicleType] ?? { direction: 'none', required: false }
}

/**
 * Human-readable vehicle-type labels. Moved here from pages/profile/RigPage so a
 * util (this file) can reuse it without a circular import (RigPage imports
 * deriveSecondVehicle from here). RigPage re-exports it for backward compat, so
 * existing `import { VEHICLE_LABELS } from './RigPage'` callers keep working.
 */
export const VEHICLE_LABELS: Record<VehicleType, string> = {
  RV_CLASS_A: 'Class A Motorhome',
  RV_CLASS_B: 'Class B / Camper Van',
  RV_CLASS_C: 'Class C Motorhome',
  FIFTH_WHEEL: 'Fifth Wheel',
  TRAVEL_TRAILER: 'Travel Trailer',
  TOY_HAULER: 'Toy Hauler',
  POP_UP: 'Pop-Up Camper',
  VAN: 'Converted Van',
  CAR_CAMPING: 'Car Camping',
}

/**
 * Display name for a rig — "[year] [make] [model]", falling back to the
 * vehicleType label when none of those are set. Single source of truth for the
 * rig-chip text used by the planning canvas (SessionPage), the trip-page rig
 * selector, the larger-rig warning, and the per-stop "booked for" label.
 *
 * vehicleType is optional so an ad-hoc one-off vehicle (year/make/model only,
 * no type — SessionPage's adHocVehicle) is handled too: with no type and no
 * year/make/model it returns '' (matching the prior inline behavior), and a
 * real Rig falls back to the friendly VEHICLE_LABELS.
 */
export function rigDisplayName(rig: {
  year?: number | null
  make?: string | null
  model?: string | null
  vehicleType?: VehicleType | null
}): string {
  const ymm = [rig.year, rig.make, rig.model].filter(Boolean).join(' ').trim()
  if (ymm) return ymm
  return rig.vehicleType ? VEHICLE_LABELS[rig.vehicleType] : ''
}

// ── Towed-field save logic (shared by the three rig forms) ──────────────────
// The local UI radio state used by the toad direction. Onboarding, Add (RigPage)
// and Edit (EditRigPage) all keep a value of this shape.
export type TowingChoice = 'NONE' | 'VEHICLE' | 'TRAILER'

/**
 * Build the direction-aware `isTowing` flag + `towed*` payload from the raw form
 * values. This is the single source of truth for the towed-field serialization
 * that RigPage, EditRigPage and OnboardingPage previously each hand-maintained
 * (and had drifted on — onboarding never saved a tow_vehicle for trailers).
 *
 *   - tow_vehicle : required. Always isTowing=true, towedType='VEHICLE', carry
 *                   year/make/model/length/plate + height/fuelType (tow-vehicle-
 *                   only fields).
 *   - toad + choice≠'NONE' : isTowing=true, towedType=choice; year/make/model
 *                   only for a VEHICLE toad; length+plate carried; height+fuelType
 *                   are never collected for a toad → null.
 *   - else (toad+NONE, or 'none' direction) : isTowing=false, everything null.
 *
 * `data` is the react-hook-form values object; unset fields arrive undefined and
 * are normalized to null so a stale value can never sneak through.
 */
export function buildTowedFields(
  data: Record<string, unknown>,
  direction: SecondVehicleDirection,
  towingChoice: TowingChoice,
): { isTowing: boolean; towed: Record<string, unknown> } {
  const cleared: Record<string, unknown> = {
    towedType: null,
    towedYear: null,
    towedMake: null,
    towedModel: null,
    towedLength: null,
    towedLicensePlate: null,
    towedHeight: null,
    towedFuelType: null,
  }

  if (direction === 'tow_vehicle') {
    return {
      isTowing: true,
      towed: {
        towedType: 'VEHICLE' as TowedType,
        towedYear: data.towedYear ?? null,
        towedMake: data.towedMake ?? null,
        towedModel: data.towedModel ?? null,
        towedLength: data.towedLength ?? null,
        towedLicensePlate: data.towedLicensePlate ?? null,
        towedHeight: data.towedHeight ?? null,
        towedFuelType: data.towedFuelType ?? null,
      },
    }
  }

  if (direction === 'toad' && towingChoice !== 'NONE') {
    return {
      isTowing: true,
      towed: {
        towedType: towingChoice as TowedType,
        towedYear: towingChoice === 'VEHICLE' ? data.towedYear ?? null : null,
        towedMake: towingChoice === 'VEHICLE' ? data.towedMake ?? null : null,
        towedModel: towingChoice === 'VEHICLE' ? data.towedModel ?? null : null,
        towedLength: data.towedLength ?? null,
        towedLicensePlate: data.towedLicensePlate ?? null,
        // Toad direction never collects height/fuelType — keep null.
        towedHeight: null,
        towedFuelType: null,
      },
    }
  }

  return { isTowing: false, towed: cleared }
}

/**
 * Build the POST body for saving a towed unit to the reusable second-vehicle
 * library (RIGINFO-4), or return null when there's nothing worth saving. Single
 * source of truth shared by RigPage / EditRigPage / OnboardingPage so the guard
 * can't drift across the three call sites.
 *
 * Returns null UNLESS the user opted in (data.saveSecondVehicle), the rig is
 * actually towing, AND the towed unit has at least one identifying field
 * (year / make / model). The last check kills the "nameless row" bug — checking
 * "save to reuse" with every identifying field blank creates no library row.
 */
export function buildSecondVehiclePayload(
  data: Record<string, unknown>,
  isTowing: boolean,
  towed: Record<string, unknown>,
): {
  towedType: unknown
  year: unknown
  make: unknown
  model: unknown
  length: unknown
  height: unknown
  licensePlate: unknown
  fuelType: unknown
} | null {
  const hasIdentifier = !!(towed.towedYear || towed.towedMake || towed.towedModel)
  if (!(data.saveSecondVehicle === true && isTowing && hasIdentifier)) return null
  return {
    towedType: towed.towedType,
    year: towed.towedYear,
    make: towed.towedMake,
    model: towed.towedModel,
    length: towed.towedLength,
    height: towed.towedHeight,
    licensePlate: towed.towedLicensePlate,
    fuelType: towed.towedFuelType,
  }
}

// ── Rig completeness (FR-RIGINFO, build-time notice) ────────────────────────
// The safety dimensions the hazard matcher reads server-side (controllers/
// trips.ts hazardFiresForRig): length (rig.length), height (rig.height), and
// weight (rig.gvwr). A rig missing any of these gets NO low-bridge / tunnel /
// weight-limit warnings on its trips. MPG drives the fuel-cost estimate; absent
// → the estimate is approximate. A field is "missing" when null/undefined.
export type RigSafetyDim = 'length' | 'height' | 'gvwr'

/** Which of the hazard-relevant safety dims (length, height, gvwr) are unset on
 *  this rig. Empty array = all three present. Structural param so it accepts a
 *  full Rig or any partial carrying these fields. */
export function missingSafetyDims(rig: {
  length?: number | null
  height?: number | null
  gvwr?: number | null
  vehicleType?: string | null
}): RigSafetyDim[] {
  // CAR_CAMPING is exempt: a car needs no rig-aware routing — standard routing
  // IS the right routing for it — so nothing is "missing" and it is never
  // flagged Incomplete or amber. (Converted vans keep the dims: high-tops
  // still hit clearance limits.)
  if (rig.vehicleType === 'CAR_CAMPING') return []
  const missing: RigSafetyDim[] = []
  if (rig.length == null) missing.push('length')
  if (rig.height == null) missing.push('height')
  if (rig.gvwr == null) missing.push('gvwr')
  return missing
}

/** MPG unset → fuel-cost estimates are approximate. */
export function missingMpg(rig: { mpg?: number | null }): boolean {
  return rig.mpg == null
}

/** Convenience: all safety dims present AND mpg set. */
export function isRigComplete(rig: {
  length?: number | null
  height?: number | null
  gvwr?: number | null
  mpg?: number | null
}): boolean {
  return missingSafetyDims(rig).length === 0 && !missingMpg(rig)
}
