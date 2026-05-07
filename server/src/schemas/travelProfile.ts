import { z } from 'zod'

/**
 * TravelProfile upsert payload — the request body for PUT /api/users/me/travel-profile.
 *
 * Mirrors the membership pattern: every field optional so partial updates work,
 * .strict() at the root rejects unknown keys outright (rather than silently
 * stripping) so a typo or malicious payload surfaces as a 400.
 *
 * SERVER-MANAGED fields (id, userId, createdAt, updatedAt) are accepted by
 * the schema but stripped in the controller before the Prisma upsert. The
 * client round-trips them when it fetches the existing profile, edits a
 * field, and PUTs the whole object back — rejecting them at the schema
 * level would 400 every save from TravelStylePage / AccessibilityPage.
 * They reach validation, then the controller destructures them out so they
 * never touch Prisma. userId on the create branch is set from req.user!.id,
 * not the body, so a client can't re-parent the row even by trying.
 *
 * SECURITY NOTE — militaryStatus / firstResponder are gated enums (not free
 * strings) because campgrounds.ts:409 (getMilitary) uses a truthy check on
 * these fields to grant access to military-only campgrounds. Without an enum
 * gate, a client could POST any non-empty string and bypass the access check.
 * The empty string '' is the explicit "None" option from the form select; it
 * is falsy in JS so the access check naturally rejects it.
 *
 * The exact enum values below were extracted from
 * client/src/pages/profile/TravelStylePage.tsx (the only client write path
 * for these two fields). If you add a new option to that page, mirror it
 * here or it will start failing validation.
 *
 * LEGACY FIELDS (Travel Party Phase A → Phase C transition):
 *   adults, children, hasPets, petDetails, accessibilityNeeds, militaryStatus,
 *   firstResponder
 * are still actively written by onboarding's style step and TravelStylePage /
 * AccessibilityPage today. They are read-fallbacks in the AI prompt and the
 * campground access checks. When Phase C lands and the columns are dropped,
 * remove the corresponding fields below in the same commit.
 */
export const TravelProfileUpsertSchema = z
  .object({
    // ─── Current fields (Phase A onward) ──────────────────────────────────
    travelStyle: z.string().max(100).nullable().optional(),
    maxDriveHours: z.number().min(0).max(24).nullable().optional(),
    maxMilesPerDay: z.number().int().min(0).max(2000).nullable().optional(),
    nightlyBudget: z.number().min(0).max(10000).nullable().optional(),
    hookupPreference: z.string().max(100).nullable().optional(),
    campgroundTypes: z.array(z.string().max(100)).nullable().optional(),
    interests: z.array(z.string().max(100)).nullable().optional(),

    // ─── Legacy fields — TODO Phase C: remove ─────────────────────────────
    // Replaced by TravelParty.people (Person rows) and TravelParty.pets
    // (Pet rows), with militaryStatus / firstResponder / accessibilityNeeds
    // moved per-Person.
    adults: z.number().int().min(0).max(20).optional(),
    children: z.number().int().min(0).max(20).optional(),
    hasPets: z.boolean().optional(),
    // petDetails has no current client write path — relaxed to z.unknown()
    // so backfill scripts and any in-flight payloads aren't broken. Tighten
    // to a real shape if/when the client starts posting it.
    petDetails: z.unknown().nullable().optional(),
    // accessibilityNeeds is posted by AccessibilityPage as an OBJECT of
    // boolean flags + a free-form `notes` string ({ wheelchair: true,
    // paved_path: false, ..., notes: '...' }), NOT a string array as the
    // schema field name suggests. Relaxed to z.unknown() to match what's
    // actually sent.
    accessibilityNeeds: z.unknown().nullable().optional(),
    militaryStatus: z
      .enum(['', 'ACTIVE', 'VETERAN', 'DEPENDENT', 'RETIRED'])
      .nullable()
      .optional(),
    firstResponder: z
      .enum(['', 'POLICE', 'FIRE', 'EMT', 'HEALTHCARE'])
      .nullable()
      .optional(),

    // ─── Server-managed (accepted from round-trip but stripped before write) ──
    // These fields exist on the persisted row and the client may include them
    // in PUT payloads when sending back an edited copy of a fetched profile.
    // We accept them at the schema level so .strict() doesn't reject the
    // payload, then the controller strips them before passing to Prisma.
    id: z.string().optional(),
    userId: z.string().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .strict()

export type TravelProfileUpsertInput = z.infer<typeof TravelProfileUpsertSchema>
