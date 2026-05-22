import { VehicleType } from '../types'

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
