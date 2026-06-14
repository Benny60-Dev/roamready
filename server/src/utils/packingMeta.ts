/**
 * Packing-list "generated-for" snapshot + staleness. Shared by the generate
 * controller (writes the snapshot) and the trip GET (computes drift), so both
 * use the EXACT same party resolution as the prompt (services/ai.ts:361-415):
 * trip-scoped party first, else the user's default party; people counted by
 * role among isTraveling members; pets by count; nights from totalNights or the
 * sum of stop nights.
 */

export interface PackingCounts {
  adults: number
  children: number
  pets: number
  petTypes: string[]
  nights: number
}

export interface PackingListMeta extends PackingCounts {
  generatedAt: string
}

export interface PackingStaleness {
  stale: boolean
  /** Which dimensions drifted: any of 'people' | 'pets' | 'nights'. */
  changed: string[]
}

/** Resolve the counts a packing list cares about from an already-resolved party
 *  (trip.party ?? user-default) and a trip (for the nights fallback). `party`
 *  may be null (no party set) → zero people/pets. */
export function resolvePackingCounts(party: any, trip: any): PackingCounts {
  const travelingPeople = (party?.people ?? []).filter((p: any) => p.isTraveling)
  const adults = travelingPeople.filter((p: any) => p.role === 'ADULT' || p.role === 'TEEN').length
  const children = travelingPeople.filter((p: any) => p.role === 'CHILD' || p.role === 'INFANT').length
  const pets = (party?.pets ?? []) as any[]
  const nights =
    trip?.totalNights ||
    (trip?.stops ?? []).reduce((sum: number, s: any) => sum + (s.nights || 1), 0) ||
    0
  return {
    adults,
    children,
    pets: pets.length,
    petTypes: pets.map((p: any) => p.type),
    nights,
  }
}

/** Compare a stored snapshot against the current counts. Legacy lists (meta
 *  null/absent) are NEVER stale — no false alarm before the snapshot exists.
 *  Drift = integer change in people (adults+children), pet count, or nights. */
export function computeStaleness(meta: any, current: PackingCounts): PackingStaleness {
  if (!meta) return { stale: false, changed: [] }
  const changed: string[] = []
  const metaPeople = (meta.adults ?? 0) + (meta.children ?? 0)
  const curPeople = current.adults + current.children
  if (metaPeople !== curPeople) changed.push('people')
  if ((meta.pets ?? 0) !== current.pets) changed.push('pets')
  if ((meta.nights ?? 0) !== current.nights) changed.push('nights')
  return { stale: changed.length > 0, changed }
}
