/**
 * State-code helpers for the visited-states map.
 *
 * IMPORTANT — bundle hygiene: this module is in the MAIN bundle (it's imported
 * by JournalTabContent, which is not lazy-loaded). It MUST NOT import the heavy
 * geometry (usStatesGeo.ts, ~165KB) or that geometry leaks out of the lazy
 * JournalStatesMap chunk into the main bundle. So the small code/name table
 * below is kept here, standalone — only JournalStatesMap imports usStatesGeo.
 *
 * Stop.locationState is stored as a 2-letter code (Google Places short_name,
 * e.g. "MT"), but we normalize defensively so a stray full name ("Montana")
 * from any older/AI-written row still maps correctly instead of silently
 * dropping off the map.
 */

/** Canonical 50 states + DC. Kept in sync with usStatesGeo.ts (same set). */
export const STATE_NAMES: Record<string, string> = {
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

/** All 51 codes (50 states + DC), in declaration order. */
export const STATE_CODES = Object.keys(STATE_NAMES)

export type StateTier = 'overnight' | 'passthrough' | 'none'

/** Per-state metadata for the visited-states map + editor. derivedTier is the
 *  auto-computed status (completed trips + journal entries); manualTier is the
 *  user's raw manual mark; locked = the state is derived-overnight (authoritative
 *  — a manual mark can't downgrade it). */
export interface StateMeta {
  derivedTier: StateTier
  manualTier: StateTier
  locked: boolean
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

/** Tiny / dense-Northeast states that need an explicit tap-target dot on
 *  mobile — their geographic paths are too small to reliably tap (scope §8.3).
 *  DC is included (rendered as a dot; it does NOT count toward the 50). */
export const SMALL_STATES = new Set(['DC', 'RI', 'DE', 'CT', 'NJ', 'MA', 'NH', 'VT', 'MD'])
