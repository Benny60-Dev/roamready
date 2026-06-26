/**
 * Round-trip intent detection — SERVER port of client/src/utils/roundTripIntent.ts.
 *
 * Used by the PRE-BUILD budget check (controllers/ai.ts) to decide the trip SHAPE
 * deterministically from the user's words — origin → turnaround → origin (round
 * trip, ×2 transit) vs origin → turnaround (one-way, ×1). This removes the ×2
 * multiplier's dependence on the model's per-run itinerary (BUG-BUDGET-SHAPE-
 * MULTIPLIER): identical input text → identical shape → identical minNeeded.
 *
 * Keep CONCEPTUALLY ALIGNED with the client recognizer and the "ROUND TRIP /
 * RETURN HOME RULE" in services/ai.ts. Word-boundary regexes (not substring
 * includes): "and back" must not match "and backpacking". Recognition errs toward
 * KEEPING the return leg.
 */

const ROUND_TRIP_RES: RegExp[] = [
  /\bround[- ]trip\b/,
  /\bcoming back home\b/,
  /\breturning home\b/,
  /\bback home\b/,
  /\bend at home\b/,
  /\bheading home after\b/,
  /\band back\b/,
  /\bthere and back\b/,
  /\breturn/, // covers "return", "returning", "returns"
  /\bcome (?:back )?home\b/,
  /\bhead(?:ing|ed)? (?:back )?home\b/,
  /\bgo(?:ing)? (?:back )?home\b/,
  /\bdriv(?:e|ing) (?:back )?home\b/,
  /\bget(?:ting)? (?:back )?home\b/,
  /\bmake it (?:back )?home\b/,
  /\bway (?:back )?home\b/,
  /\bcircle back\b/,
  /\bloop (?:trip|drive|route|back|around)\b/,
  /\bout[- ]and[- ]back\b/,
]

const ONE_WAY_RES: RegExp[] = [
  /\bone[- ]way\b/,
  /\boneway\b/,
  /\bnot (?:a )?round[- ]?trip\b/,
  /\bno return\b/,
  /\bnot (?:coming|going|driving|heading) back\b/,
  /\bdon'?t (?:need|want|plan)(?:ning)?(?: to)? (?:come|go|drive|head)\s*(?:back|home)\b/,
  /\bmoving to\b/,
  /\brelocating to\b/,
]

/** Origins the user stated in their own messages: "from X", "leaving from X", etc.
 *  Loose by design — candidates only feed the "back to <X>" check below. */
export function statedOrigins(userMessages: string[]): string[] {
  const out: string[] = []
  const re = /\b(?:leaving from|starting (?:in|from|at)|departing from|from|out of)\s+([a-z][a-z .'-]{2,40}?)(?=[,.!?;)]|\s+(?:to|and|on|for|in|with|next|this|tomorrow)\b|$)/gim
  for (const t of userMessages) {
    for (const m of t.matchAll(re)) out.push(m[1].trim().toLowerCase())
  }
  return out
}

/** True when the conversation expresses explicit round-trip intent. */
export function hasRoundTripIntent(
  userMessages: string[],
  originCandidates: Array<string | null | undefined> = [],
): boolean {
  const text = userMessages.join(' ').toLowerCase()
  if (ROUND_TRIP_RES.some(re => re.test(text))) return true

  const candidates = [...originCandidates, ...statedOrigins(userMessages)]
    .filter((c): c is string => typeof c === 'string')
    .map(c => c.toLowerCase().trim())
    .flatMap(c => [c, c.split(',')[0].trim()])
    .filter(c => c.length >= 3)

  return candidates.some(c => text.includes(`back to ${c}`))
}

/** True when the conversation expresses EXPLICIT one-way intent. */
export function hasOneWayIntent(userMessages: string[]): boolean {
  const text = userMessages.join(' ').toLowerCase()
  return ONE_WAY_RES.some(re => re.test(text))
}
