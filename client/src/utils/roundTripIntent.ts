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
 * ARCHITECTURE (post AI-RT-2): the MODEL is the primary round-trip decider — it
 * infers intent from the user's natural language. This file is the CLIENT
 * BACKSTOP recognizer: hasRoundTripIntent() recognizes round-trip language so we
 * KEEP a model-built return leg, and hasOneWayIntent() recognizes explicit
 * one-way language so the backstop only strips a return leg when there is
 * POSITIVE one-way evidence (never merely because a phrase test missed). The
 * model-side prompt rules in server/src/services/ai.ts ("ROUND TRIP / RETURN
 * HOME RULE" and the one-way default block) describe the SAME natural-language
 * intent — keep them CONCEPTUALLY ALIGNED with the recognizers here (they no
 * longer need to be a textually identical exact-phrase whitelist). Recognition
 * errs toward KEEPING the return leg. Regression-checked by
 * scripts/check-round-trip-intent.ts.
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
  // Natural-language "come back to the origin" variants (AI-RT-2 — the model
  // already infers these; the backstop recognizes them so it never strips a
  // correct return leg). Word-bounded so "backpacking" etc. never match.
  /\bcome (?:back )?home\b/,            // "come home", "come back home"
  /\bhead(?:ing|ed)? (?:back )?home\b/, // "head home", "heading home", "head back home"
  /\bgo(?:ing)? (?:back )?home\b/,      // "go home", "going back home"
  /\bdriv(?:e|ing) (?:back )?home\b/,   // "drive home", "driving back home"
  /\bget(?:ting)? (?:back )?home\b/,    // "get home", "getting back home"
  /\bmake it (?:back )?home\b/,
  /\bway (?:back )?home\b/,             // "on the way home", "way back home"
  /\bcircle back\b/,
  /\bloop (?:trip|drive|route|back|around)\b/,
  /\bout[- ]and[- ]back\b/,
]

// Explicit ONE-WAY language. Used ONLY by the backstop strip as POSITIVE
// evidence to remove a return leg the model over-added — kept tight so it never
// fires on an ordinary destination ask (e.g. "drive to Denver"), which the model
// already one-ways on its own.
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

/**
 * True when the conversation expresses EXPLICIT one-way intent — the positive
 * evidence the backstop needs before stripping a model-built return leg. Absent
 * this (and absent round-trip intent), the trip is AMBIGUOUS and the backstop
 * keeps whatever the model built. Round-trip intent takes precedence: callers
 * should check hasRoundTripIntent() first.
 */
export function hasOneWayIntent(userMessages: string[]): boolean {
  const text = userMessages.join(' ').toLowerCase()
  return ONE_WAY_RES.some(re => re.test(text))
}
