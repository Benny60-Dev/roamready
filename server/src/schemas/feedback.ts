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

// Screenshot attachments: images only, never persisted — decoded buffers are
// forwarded to the support notification email and dropped. Validation trusts
// the bytes, not the filename: base64 must be well-formed, decode to ≤4MB,
// and start with png/jpeg/webp magic bytes.
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
// 4MB decoded ≈ 5.6M base64 chars; cap the raw string before decoding so a
// hostile payload can't make us buffer far more than we'd ever accept.
const MAX_ATTACHMENT_BASE64_CHARS = 6_000_000
// Charset class + length%4 instead of the textbook grouped-quantifier
// regex: V8 compiles repeated groups recursively and stack-overflows on
// multi-megabyte strings. A bare character class scans linearly.
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/

function isAllowedImage(buf: Buffer): boolean {
  const png = buf.length > 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const jpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  const webp = buf.length > 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  return png || jpeg || webp
}

const AttachmentSchema = z
  .object({
    filename: z.string().min(1).max(200),
    data: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
  })
  .strict()
  .superRefine((att, ctx) => {
    if (att.data.length % 4 !== 0 || !BASE64_CHARS_RE.test(att.data)) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: 'attachment data is not valid base64' })
      return
    }
    const buf = Buffer.from(att.data, 'base64')
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: 'attachment exceeds 4MB' })
      return
    }
    if (!isAllowedImage(buf)) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: 'attachment is not a png, jpeg, or webp image' })
    }
  })

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
    // Plain .optional() — no preprocess pipe, so the Zod v4 outer/inner
    // placement gotcha (see title/importance above) doesn't apply here.
    attachments: z.array(AttachmentSchema).max(3).optional(),
  })
  .strict()

export const AdminFeedbackUpdateSchema = z
  .object({
    status: z.enum(['NEW', 'PLANNED', 'IN_PROGRESS', 'SHIPPED', 'DECLINED']).optional(),
    isPublic: z.boolean().optional(),
    // true → controller stamps archivedAt = now(); false → clears it.
    // Boolean on the wire, timestamp in the DB.
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(d => d.status !== undefined || d.isPublic !== undefined || d.archived !== undefined, {
    message: 'Provide status, isPublic, and/or archived',
  })

export type FeedbackSubmitInput = z.infer<typeof FeedbackSubmitSchema>
export type AdminFeedbackUpdateInput = z.infer<typeof AdminFeedbackUpdateSchema>
