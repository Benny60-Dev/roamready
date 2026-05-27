// Mirrors client/src/constants/memberships.ts. These ids are stored verbatim
// in Membership.type. Keep in sync with the client list — they are
// intentionally independent (no shared package).

export const MEMBERSHIP_TYPES = [
  'ATB',
  'GOOD_SAM',
  'THOUSAND_TRAILS',
  'COAST_TO_COAST',
  'ESCAPEES',
  'FMCA',
  'HARVEST_HOSTS',
  'BOONDOCKERS_WELCOME',
] as const

export type MembershipType = (typeof MEMBERSHIP_TYPES)[number]
