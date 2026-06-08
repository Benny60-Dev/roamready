import { z } from 'zod'

/**
 * VisitedState — manual visited-state marks (Journal map, step 6b).
 *
 * The upsert body carries only visitType; userId comes from req.user and the
 * state code comes from the :state route param (validated by normalizeStateCode
 * below). .strict() rejects any other key.
 *
 * visitType is a String at the DB layer (locked decision — no enum migration);
 * it's constrained to the two valid values HERE at the Zod layer.
 */

export const VISIT_TYPES = ['overnight', 'passthrough'] as const

export const VisitedStateUpsertSchema = z
  .object({
    visitType: z.enum(VISIT_TYPES),
  })
  .strict()

export type VisitedStateUpsertInput = z.infer<typeof VisitedStateUpsertSchema>

// ─── State-code validation ──────────────────────────────────────────────────
// Mirrors client/src/components/journal/stateUtils.ts (50 states + DC). Kept in
// sync by hand — both are small and rarely change.
const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}

const VALID_CODES = new Set(Object.keys(STATE_NAMES))
const NAME_TO_CODE = new Map(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
)

/** Normalize a raw state value (2-letter code OR full name, any case) to its
 *  canonical 2-letter code, or null if unrecognized. */
export function normalizeStateCode(raw?: string | null): string | null {
  if (!raw) return null
  const t = raw.trim()
  if (!t) return null
  const upper = t.toUpperCase()
  if (t.length === 2 && VALID_CODES.has(upper)) return upper
  return NAME_TO_CODE.get(t.toLowerCase()) ?? null
}
