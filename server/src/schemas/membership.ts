import { z } from 'zod'

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
    type: z.string().min(1).max(100).optional(),
    memberNumber: z.string().max(100).nullable().optional(),
    planTier: z.string().max(100).nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    autoApply: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

export type MembershipUpdateInput = z.infer<typeof MembershipUpdateSchema>
