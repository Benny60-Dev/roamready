import { z } from 'zod'
import { MEMBERSHIP_TYPES } from '../constants/memberships'

/**
 * Membership update payload — the request body for PUT /api/users/me/memberships/:id.
 *
 * Fields here are exhaustively listed and all .optional() so partial updates
 * work; .strict() at the root rejects unknown keys outright (rather than
 * silently stripping) so a typo or malicious payload surfaces as a 400.
 *
 * OMITTED server-managed fields (will be rejected if the client sends them):
 *   - id, createdAt — never client-writable
 *   - userId — would let a user re-parent the membership onto another account
 */
export const MembershipUpdateSchema = z
  .object({
    type: z.enum(MEMBERSHIP_TYPES).optional(),
    memberNumber: z.string().max(100).nullable().optional(),
    planTier: z.string().max(100).nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    autoApply: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

export type MembershipUpdateInput = z.infer<typeof MembershipUpdateSchema>

/**
 * Membership create payload — the request body for POST /api/users/me/memberships.
 *
 * Same allowlisted fields as MembershipUpdateSchema, but `type` is REQUIRED at
 * creation time (it's the membership program — Good Sam, KOA, etc.; we won't
 * insert a row without one). All other fields stay optional to match the
 * frontend, which lets users add a membership with just a program name and
 * fill the rest in later via the edit screen.
 *
 * OMITTED server-managed fields (will be rejected if the client sends them
 * thanks to .strict()):
 *   - id, createdAt, updatedAt — never client-writable
 *   - userId — set from req.user in the controller; allowing it on the body
 *     would let a client create a membership owned by another user
 */
export const MembershipCreateSchema = z
  .object({
    type: z.enum(MEMBERSHIP_TYPES),
    memberNumber: z.string().max(100).nullable().optional(),
    planTier: z.string().max(100).nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    autoApply: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

export type MembershipCreateInput = z.infer<typeof MembershipCreateSchema>
