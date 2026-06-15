/**
 * Round-trip intent detection (AI-RT-1) — shared by SessionPage's
 * stripUnrequestedReturnLeg guard and regression-checked by
 * scripts/check-round-trip-intent.ts (npm run check:round-trip-intent).
 *
 * The original phrase list missed "and back" / "there and back" / "return",
 * and its "back to <X>" variant only knew the PROFILE home city — an account
 * with no saved home that typed "Mesa to NY and back" had its return leg
 * silently amputated (prod session cmqb8f4p4001o…). Origin candidates now
 * include any origin the user stated in chat and the itinerary's own first
 * (HOME) stop.
 *
 * Word-boundary regexes, not substring includes: "and back" must not match
 * "and backpacking". Matching errs toward KEEPING the return leg — the
 * failure mode of a false positive is an unstripped round trip the user can
 * see and fix, vs. the silent surgery this guard caused before.
 *
 * SINGLE SOURCE OF TRUTH for the round-trip trigger phrases. The model-side
 * prompt mirrors this list in TWO places — both must stay textually identical
 * to ROUND_TRIP_RES below, or the model will one-way a trip this guard would
 * have kept (or vice-versa):
 *   • server/src/services/ai.ts "ROUND TRIP / RETURN HOME RULE" (~:198)
 *   • server/src/services/ai.ts "ONE-WAY IS THE UNCONDITIONAL DEFAULT" (~:225)
 * If you add/remove a phrase here, update BOTH prompt locations in the same
 * change. Regression-checked by scripts/check-round-trip-intent.ts.
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
]

/** Origins the user stated in their own messages: "from X", "leaving from X",
 *  "starting in/at/from X", "departing from X", "out of X". Loose by design —
 *  candidates only feed the "back to <X>" check below. */
export function statedOrigins(userMessages: string[]): string[] {
  const out: string[] = []
  const re = /\b(?:leaving from|starting (?:in|from|at)|departing from|from|out of)\s+([a-z][a-z .'-]{2,40}?)(?=[,.!?;)]|\s+(?:to|and|on|for|in|with|next|this|tomorrow)\b|$)/gim
  for (const t of userMessages) {
    for (const m of t.matchAll(re)) out.push(m[1].trim().toLowerCase())
  }
  return out
}

/**
 * True when the conversation expresses explicit round-trip intent.
 * @param userMessages every user-authored message in the session
 * @param originCandidates known origin names beyond the user's own text —
 *        profile homeCity and the itinerary's first (HOME) stop name.
 */
export function hasRoundTripIntent(
  userMessages: string[],
  originCandidates: Array<string | null | undefined> = [],
): boolean {
  const text = userMessages.join(' ').toLowerCase()
  if (ROUND_TRIP_RES.some(re => re.test(text))) return true

  const candidates = [...originCandidates, ...statedOrigins(userMessages)]
    .filter((c): c is string => typeof c === 'string')
    .map(c => c.toLowerCase().trim())
    // drop a trailing ", st" state suffix so "back to mesa" matches "Mesa, AZ"
    .flatMap(c => [c, c.split(',')[0].trim()])
    .filter(c => c.length >= 3)

  return candidates.some(c => text.includes(`back to ${c}`))
}
