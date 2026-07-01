import { z } from 'zod'

/**
 * SecondVehicle create payload — the request body for POST /api/users/me/second-vehicles.
 *
 * A saved, reusable toad / tow-vehicle (RIGINFO-4). `towedType` is REQUIRED (a
 * saved row is meaningless without knowing whether it's a flat-towed VEHICLE or
 * a TRAILER); everything else is optional so a user can save a partial and fill
 * the rest in later. .strict() rejects unknown keys with a 400.
 *
 * OMITTED server-managed fields (rejected by .strict() if the client sends them):
 *   - id, createdAt, updatedAt — never client-writable
 *   - userId — set from req.user in the controller; allowing it on the body
 *     would let a client create a vehicle owned by another user
 */
export const SecondVehicleCreateSchema = z
  .object({
    towedType: z.enum(['VEHICLE', 'TRAILER']),
    year: z.number().int().nullable().optional(),
    make: z.string().max(100).nullable().optional(),
    model: z.string().max(100).nullable().optional(),
    length: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    licensePlate: z.string().max(20).nullable().optional(),
    fuelType: z.string().max(20).nullable().optional(),
  })
  .strict()

export type SecondVehicleCreateInput = z.infer<typeof SecondVehicleCreateSchema>
