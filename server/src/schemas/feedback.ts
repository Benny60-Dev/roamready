import { z } from 'zod'

/**
 * Feedback Zod schemas (Pass 1 hardening).
 *
 * Convention follows journal.ts / travelParty.ts:
 *   - .strict() at the root rejects unknown keys with a 400
 *   - Server-managed fields are NEVER here — the controller injects them:
 *       userId            — injected from req.user!.id
 *       isPublic          — admin-decided (Prisma default true; the status
 *                           gate in getPublicRoadmap controls visibility)
 *       status / votes / voterIds / id / createdAt — never client-writable
 *
 * CAMPGROUND_REVIEW is intentionally absent from the type enum — the DB
 * enum value stays dormant; new submissions can no longer use it.
 */

// The modal's <select>s submit '' for "no choice" on optional fields —
// normalize to undefined so optional() applies instead of a 400.
//
// Zod v4 placement gotcha: a preprocess pipe is non-optional at the
// object level no matter what its inner schema says, so the OUTER
// .optional() is what lets the key be absent entirely; the INNER one
// is what lets the preprocessed ''→undefined pass. Both are required.
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v)

export const FeedbackSubmitSchema = z
  .object({
    type: z.enum(['FEATURE_REQUEST', 'BUG_REPORT', 'GENERAL']),
    title: z.preprocess(emptyToUndefined, z.string().min(1).max(200).optional()).optional(),
    body: z.string().min(1).max(5000),
    screen: z.string().max(500).optional(),
    rating: z.number().int().min(1).max(5).optional(),
    importance: z.preprocess(
      emptyToUndefined,
      z.enum(['nice_to_have', 'important', 'critical']).optional(),
    ).optional(),
    rigType: z.string().max(200).optional(),
    tripContext: z.string().max(2000).optional(),
  })
  .strict()

export const AdminFeedbackUpdateSchema = z
  .object({
    status: z.enum(['NEW', 'PLANNED', 'IN_PROGRESS', 'SHIPPED', 'DECLINED']).optional(),
    isPublic: z.boolean().optional(),
  })
  .strict()
  .refine(d => d.status !== undefined || d.isPublic !== undefined, {
    message: 'Provide status and/or isPublic',
  })

export type FeedbackSubmitInput = z.infer<typeof FeedbackSubmitSchema>
export type AdminFeedbackUpdateInput = z.infer<typeof AdminFeedbackUpdateSchema>
