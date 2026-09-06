import { Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../utils/prisma'
import { AuthRequest, hasAccess } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { chatWithAI, generatePackingListAI, analyzeFeedbackAI, generatePlanningContextSummary } from '../services/ai'
import { sendAiUsageWarning } from '../services/feedbackNotification'
import {
  parseModifyBlocks, stripAppliedClaims, neutralizeLegacyMarkers,
  annotateForModel, buildAppliedLookup, actionKey,
} from '../services/modifyActions'
import { parseTripDate } from '../utils/dates'
import { computeTripShape } from '../utils/tripShape'
import { hasRoundTripIntent } from '../utils/roundTripIntent'
// PLAN-IS-TRUTH (Part 2, step 2) — the deterministic drive-time check, shared
// with build's expandLongLegs. trips.ts already imports enforcePerUserDailyCap
// from this module; both exports are only ever CALLED inside request handlers
// (never at module load), so the two-way import resolves cleanly at call time.
import { parsePetTag, persistCapturedPets } from '../services/petCapture'
import { planTransitInserts, deriveCapHours, buildTransitNote, buildViolationAdvisory, minimalTripBudget, rigDimsFromRig, detectStopHazards, geocodeOriginText, recheckLongLegs, computeDriveFacts, type DriveFacts } from './trips'

// Soft cap: inject a "wrap up" system message and let Claude actually respond
// (so it has a chance to emit the <itinerary> JSON block).
// Hard cap: short-circuit purely for cost protection.
const SOFT_CAP = 600
const HARD_CAP = 1000

// Per-user daily AI call cap for non-paying, non-trial, non-owner accounts.
// Quiet cost protection — NOT a marketing tier, NOT in FEATURE_GATES, NOT
// advertised on the pricing page. Legitimate users never hit it; only
// triggers on actual abuse (someone signing up to spam the AI before/after
// their trial). 30 calls/24h is generous for normal planning flow which
// typically uses 5-10 AI calls per trip, and is small enough to bound a
// single bad-faith account's Anthropic spend.
const FREE_TIER_AI_DAILY_CAP = 30
const FREE_TIER_AI_WINDOW_MS = 24 * 60 * 60 * 1000

/** Enforce the daily AI cap for non-Pro / non-trial / non-owner users.
 *  Pulls req.user from the auth middleware (already shaped with
 *  subscriptionTier, trialEndsAt, isOwner — no extra DB fetch needed).
 *  Returns true if the cap was hit AND the response was sent — caller
 *  must early-return. Returns false otherwise; caller continues. */
async function enforceFreeAiCap(req: AuthRequest, res: Response): Promise<boolean> {
  const u = req.user!
  const now = new Date()
  // Anyone with full Pro access — paid PRO, active trial, paid-through grace, a
  // valid complimentary comp, or owner — is exempt from the free-tier cap. Routed
  // through the shared hasAccess (server source of truth) so a comped user
  // (subscriptionTier=FREE + compTier=PRO) is NOT rate-limited as free; an expired
  // comp and plain free still fall through to the cap.
  if (hasAccess(u, 'aiPlannerUnlimited')) return false

  const windowStart = new Date(now.getTime() - FREE_TIER_AI_WINDOW_MS)
  const recentCallCount = await prisma.aIUsageLog.count({
    where: {
      userId: u.id,
      createdAt: { gte: windowStart },
    },
  })
  if (recentCallCount >= FREE_TIER_AI_DAILY_CAP) {
    console.warn(
      `[AI cap] userId=${u.id} hit daily cap (${recentCallCount}/${FREE_TIER_AI_DAILY_CAP}) — ` +
      `returning 429 DAILY_LIMIT`
    )
    res.status(429).json({
      error: 'DAILY_LIMIT',
      message: "You've reached your daily AI limit. Upgrade to Pro for unlimited trip planning, or try again tomorrow.",
    })
    return true
  }
  return false
}

// ── Per-user daily AI cap (ALL tiers) + heavy-usage owner alert — LS-AI-USAGE-CAP
// A SECOND, tier-AGNOSTIC backstop layered ON TOP OF enforceFreeAiCap. Where the
// free cap stops a free account from spamming the AI, this one bounds ANY single
// account's daily Anthropic spend — free, trial, Pro, even owner — against
// runaway usage (a buggy client retry loop, a shared login, deliberate abuse).
// Both caps are tunable; this one is set well above any legitimate planning flow.
const PER_USER_DAILY_CALL_CAP = 200
const PER_USER_DAILY_WARN_THRESHOLD = 100
const PER_USER_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000

// In-memory dedupe for the heavy-usage warning email: at most one alert per user
// per UTC day, keyed `${userId}:${YYYY-MM-DD}`. Intentionally NOT persisted — it
// resets on backend restart, which is acceptable for a fire-and-forget owner
// alert (worst case: one duplicate alert right after a deploy). No schema/table.
const warnedHeavyUsers = new Set<string>()

/** Tier-agnostic per-user daily AI cap. Applies to EVERY account — NO Pro/trial/
 *  owner exemption (unlike enforceFreeAiCap); it's a pure cost backstop, not a
 *  tier feature. Additional to (never a replacement for) enforceFreeAiCap.
 *  Returns true if the cap was hit AND the 429 was sent — caller must
 *  early-return. Crossing PER_USER_DAILY_WARN_THRESHOLD also fires a
 *  once-per-user-per-day owner alert email; that send is fully fire-and-forget
 *  and can never break or delay the user's request. */
export async function enforcePerUserDailyCap(req: AuthRequest, res: Response): Promise<boolean> {
  const u = req.user!
  const now = new Date()
  const windowStart = new Date(now.getTime() - PER_USER_DAILY_WINDOW_MS)

  const recentCallCount = await prisma.aIUsageLog.count({
    where: { userId: u.id, createdAt: { gte: windowStart } },
  })

  // Heavy-usage owner alert — fired at the WARN threshold (below the hard cap),
  // once per user per UTC day, so a heavy account is flagged even if it never
  // reaches the block. Entirely fire-and-forget; a Resend failure is swallowed.
  if (recentCallCount >= PER_USER_DAILY_WARN_THRESHOLD) {
    const dayKey = `${u.id}:${now.toISOString().slice(0, 10)}`
    if (!warnedHeavyUsers.has(dayKey)) {
      warnedHeavyUsers.add(dayKey)
      const isTrial = !!(u.trialEndsAt && now < new Date(u.trialEndsAt))
      // Comp-aware label so a comped user reads as 'comp', not the misleading
      // 'free' (mirrors hasAccess's comp clause: PRO + lifetime-or-unexpired).
      const isComp = u.compTier === 'PRO' && (!u.compExpiresAt || now < new Date(u.compExpiresAt))
      const tier = u.isOwner ? 'owner' : u.subscriptionTier === 'PRO' ? 'Pro' : isComp ? 'comp' : isTrial ? 'trial' : 'free'
      void (async () => {
        try {
          const agg = await prisma.aIUsageLog.aggregate({
            _sum: { estimatedCostUsd: true },
            where: { userId: u.id, createdAt: { gte: windowStart } },
          })
          // _sum is a Prisma Decimal (or null) — coerce via Number before toFixed.
          const costUsd = Number(agg._sum.estimatedCostUsd ?? 0).toFixed(2)
          await sendAiUsageWarning({
            userEmail: u.email,
            userId: u.id,
            callCount: recentCallCount,
            costUsd,
            tier,
            cap: PER_USER_DAILY_CALL_CAP,
            threshold: PER_USER_DAILY_WARN_THRESHOLD,
          })
        } catch (err: any) {
          // A send failure must NEVER surface to the user — log and move on.
          console.error('[AI cap] heavy-usage warning email failed for userId=%s: %s', u.id, err?.message ?? err)
        }
      })()
    }
  }

  if (recentCallCount >= PER_USER_DAILY_CALL_CAP) {
    // Rolling 24h window: usage eases as the oldest in-window calls age out.
    // Tell the user when the oldest call crosses 24h (count drops below the cap
    // then). Approximate + friendly; this extra query only runs on the rare
    // blocked request, never on the happy path.
    const oldest = await prisma.aIUsageLog.findFirst({
      where: { userId: u.id, createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    })
    const resetMs = oldest
      ? (oldest.createdAt.getTime() + PER_USER_DAILY_WINDOW_MS) - now.getTime()
      : PER_USER_DAILY_WINDOW_MS
    const hoursToReset = Math.max(1, Math.ceil(resetMs / (60 * 60 * 1000)))
    console.warn(
      `[AI cap] userId=${u.id} hit PER-USER daily cap (${recentCallCount}/${PER_USER_DAILY_CALL_CAP}) — ` +
      `returning 429 DAILY_USER_CAP`
    )
    res.status(429).json({
      error: 'DAILY_USER_CAP',
      message: `You've hit today's trip-planning limit (${PER_USER_DAILY_CALL_CAP} AI requests in 24 hours). It resets in about ${hoursToReset} hour${hoursToReset === 1 ? '' : 's'} — thanks for your patience.`,
    })
    return true
  }
  return false
}

const VIBES = [
  'a quiet alpine lake setting',
  'high desert with red rock formations',
  'coastal cliffs or rugged shoreline',
  'dense old-growth forest',
  'wide open prairie or grassland',
  'a river canyon, ideally with hot springs nearby',
  'volcanic or geothermal landscape',
  'boreal lakes and birch forest',
]

// Hard-cap copy is context-aware (planning vs modify) and honest: it states the
// AI has STOPPED responding in THIS chat, what is actually saved, and how to
// continue. It does NOT promise the conversation transcript carries over — a new
// session/trip starts with empty conversation fields (see MODIFY-CAP-1).
const HARD_CAP_RESPONSE_PLANNING =
  "We've covered a lot in this planning session! 🗺️ I've reached my limit for this " +
  "conversation, so I won't be able to respond here anymore. Your progress is saved — you " +
  "can come back to this trip anytime, or start a fresh planning session to keep going."

const HARD_CAP_RESPONSE_MODIFY =
  "We've made a lot of changes here! 🗺️ I've reached my limit for this conversation, so " +
  "I won't be able to respond in this chat anymore. Your trip and all applied changes are " +
  "saved — just close and reopen \"Modify with AI\" to start a fresh session and keep editing."

const SOFT_CAP_NUDGE =
  '\n\nIMPORTANT: This conversation has gotten long. If you have enough information ' +
  'to build a trip itinerary, please wrap up your response and emit the ' +
  '<itinerary>...</itinerary> JSON block now. Do not ask further clarifying ' +
  'questions unless absolutely necessary.'

// AI-MESA-7 — deterministic origin guard. Prompt fixes (AI-MESA-4/5/6) could not
// reliably stop the model fabricating an origin city for no-home users (7 runs,
// 6 fabricated). When the guard below detects a fabricated HOME city, it replaces
// the whole assistant turn with this canned ask. NO <itinerary> block here, so the
// client's parseItinerary returns null and shows no Build button — the trip cannot
// build until the user provides a real starting city.
const NO_ORIGIN_RESPONSE =
  "Quick thing first — I don't have a home address saved to your profile yet. Are you " +
  "starting from home, or somewhere else this trip? If it's home, share your address and " +
  "I'll help you save it for future trips; otherwise just give me your starting location " +
  "and I'll get going."

// FEAT-ORIGIN-RESOLVER — shown ONLY when the user answered the origin question but
// the answer could not be geocoded (resolveTripOrigin's safeguard: never store an
// ungeocodable origin). Acknowledges the miss and asks once more — no infinite loop.
const NO_ORIGIN_RETRY_RESPONSE =
  "Hmm, I couldn't find that location on the map. Could you give me the city (and state) " +
  "you're starting from — for example \"Las Vegas, NV\" — and I'll get going."

// FEAT-ORIGIN-RESOLVER — strip conversational lead-in from a free-form origin
// ANSWER so the remainder geocodes cleanly ("I'm starting at the Suncoast Casino"
// → "the Suncoast Casino"; "leaving from Summerlin" → "Summerlin"; "from Denver"
// → "Denver"). Conservative: only peels known opener phrases, never mangles a
// bare place name.
function stripOriginLeadIn(text: string): string {
  return text
    .trim()
    .replace(/^(?:i['’]?m|i am|we['’]?re|we are|it['’]?s|its)\s+/i, '')
    .replace(/^(?:currently\s+)?(?:starting|leaving|departing|coming|driving|heading(?:\s+out)?|setting\s+out)\s+(?:from|at|in|out\s+of)\s+/i, '')
    .replace(/^(?:start|leave|depart)\s+(?:from|at|in)\s+/i, '')
    .replace(/^(?:from|at|in|near)\s+/i, '')
    .trim()
}

// isOriginAsk — concept-based detection of an origin/home/departure-address ask,
// used by the INVERTED origin guard below to catch a redundant ask when the
// origin is already known. A fixed phrase-list leaks because the model
// paraphrases (proven in the wild: "leaving from home in Sioux Falls, or a
// different address" was NOT caught by the old fixed phrase-list). Instead we fire when an
// origin/home/departure keyword appears inside a QUESTION clause. Per-clause
// isolation (split on . ! ?) means a legitimate dates/party question in the same
// reply ("when are you heading out, how many nights?") is NOT suppressed — only
// the clause that both ends in "?" AND mentions origin/home/departure triggers.
const ORIGIN_ASK_KEYWORDS = /\b(?:starting from|leaving from|departing from|depart from|start from|where (?:are|will) you (?:be )?(?:starting|leaving|departing)|from home|home in|your home|home address|home base|different address|different location|different place|another (?:address|location|place)|somewhere else|starting (?:point|location)|saved home|on file)\b/i
function isOriginAsk(text: string | null | undefined): boolean {
  if (!text) return false
  // BUG-ORIGIN-ASK-MARKDOWN — strip markdown emphasis first: "…Mesa, AZ.**
  // Last thing: how many nights…?" has no whitespace after the period, so the
  // clause splitter fused an origin STATEMENT with a nights QUESTION and the
  // user's "2" was geocoded as a place. Bold/italic markers are not sentence
  // punctuation; drop them before splitting.
  const plain = text.replace(/[*_`]+/g, '')
  for (const c of plain.split(/(?<=[?.!])\s+/)) {
    if (!c.includes('?') || !ORIGIN_ASK_KEYWORDS.test(c)) continue
    // A clause that is really asking about LENGTH ("how many nights…?") while
    // merely restating the origin is not an origin ask.
    if (/\bhow (?:many|long)\b|\bnights?\b/i.test(c) && /\b(?:starting|leaving|departing) from home\b/i.test(c)) continue
    return true
  }
  // Statement-form safety net (NO_ORIGIN_RESPONSE opens with this, no "?" clause).
  if (/\bi don't have a home address\b/i.test(text)) return true
  return false
}

// Server-side mirror of the client's parseItinerary (SessionPage.tsx). Extracts the
// <itinerary>…</itinerary> JSON from an assistant reply and parses it. Returns the
// parsed object, or null on no-match / parse failure. NEVER throws — the guard must
// fail open (no itinerary detected → no block) rather than break the chat response.
function parseItineraryBlock(text: string): any | null {
  try {
    let inner = text.match(/<itinerary>([\s\S]*?)<\/itinerary>/)?.[1]
    if (!inner) inner = text.match(/<itinerary>([\s\S]*)/)?.[1]
    if (!inner) return null
    inner = inner.trim()
    try {
      return JSON.parse(inner)
    } catch {
      const m = inner.match(/\{[\s\S]*\}/)
      if (m) {
        try { return JSON.parse(m[0]) } catch { return null }
      }
      return null
    }
  } catch {
    return null
  }
}

// The 9 VehicleType enum values (prisma schema). Used ONLY to validate the
// captured <rig> tag before persisting partialTripData.statedRig — advisory
// metadata, never a calc input.
const VEHICLE_TYPES = [
  'RV_CLASS_A', 'RV_CLASS_B', 'RV_CLASS_C', 'FIFTH_WHEEL', 'TRAVEL_TRAILER',
  'TOY_HAULER', 'POP_UP', 'VAN', 'CAR_CAMPING',
] as const

// PLANNING-RETENTION (A1) — partialTripData is a shared JSON bag on the session
// (today: { origin?, agreedStops?, statedRig? }). ALWAYS read-modify-write so a
// write to one key never clobbers the others — persisting agreedStops must
// preserve a previously-captured origin/statedRig, and vice-versa.
async function mergePartialTripData(sessionId: string, patch: Record<string, unknown>): Promise<void> {
  const cur = await prisma.planningSession.findUnique({
    where: { id: sessionId },
    select: { partialTripData: true },
  })
  const base =
    cur?.partialTripData && typeof cur.partialTripData === 'object' && !Array.isArray(cur.partialTripData)
      ? (cur.partialTripData as Record<string, unknown>)
      : {}
  await prisma.planningSession.update({
    where: { id: sessionId },
    data: { partialTripData: { ...base, ...patch } as any },
  })
}

// PLANNING-RETENTION (A1) — render the agreed stop-set as a grounding system
// message (the planning analog of modify mode's buildLiveTripState). Injected on
// every planning turn so early-stated stops survive HISTORY_CAP and the model
// re-includes them when it regenerates a full <itinerary>.
function buildAgreedStopsState(
  stops: Array<{ name?: string | null; state?: string | null; type?: string | null; nights?: number | null }>,
): string {
  const lines = stops.map((s, i) => {
    const loc = [s.name, s.state].filter(Boolean).join(', ') || '(unnamed stop)'
    const type = s.type || 'DESTINATION'
    const nights = typeof s.nights === 'number' ? s.nights : 0
    return `  ${i + 1}. ${loc} — ${type}, ${nights} night${nights === 1 ? '' : 's'}`
  })
  return [
    'GROUND-TRUTH ITINERARY SO FAR — these stops were already agreed earlier in THIS planning conversation:',
    ...lines,
    'When you emit a full <itinerary>, you MUST include EVERY one of these stops, in this order, unless the user has EXPLICITLY asked in a later message to remove, replace, or reorder one. Do NOT silently drop, rename, or reorder them. Add any newly-requested stops in their correct route position, and keep all legs the user stated — including destinations AFTER the headline destination and any return-toward-home leg.',
  ].join('\n')
}

// AI-MESA-9 — prose origin-assertion extractor. The AI-MESA-7 guard only inspects
// the <itinerary> JSON, so a fabricated origin stated in PRE-ITINERARY PROSE (e.g.
// the scripted "Got it — starting from <City>" / "I'll use your home address in
// <City>" confirmation lines) slipped through (the Pittsburgh→Columbus and the
// "home address in Phoenix" cases). This extractor scans an assistant reply for an
// ORIGIN-ANCHORED assertion and returns the asserted city's first proper-noun token,
// or null. It is deliberately origin-only: it NEVER matches destination phrasings
// ("trip to X", "heading to X", "arrive in X"), so a destination city can never be
// mistaken for an asserted origin. Single-token capture is sufficient — the guard
// only needs the city's first token to check whether the user ever typed it.
function extractAssertedOrigin(text: string): string | null {
  const CITY = "([A-Za-z][A-Za-z'-]*)"
  const PATTERNS = [
    // "starting from Columbus" OR "starting from your home address in Phoenix"
    "starting from\\s+(?:your\\s+home\\s+(?:address|base)\\s+(?:in|at)\\s+)?" + CITY,
    "home\\s+(?:address|base)\\s+(?:in|at|is)\\s+" + CITY,   // "home address in Phoenix" / "home base is Denver"
    "your\\s+home\\s+(?:in|is)\\s+" + CITY,                  // "your home in Phoenix"
    CITY + "\\s+as\\s+(?:the|your)\\s+(?:starting point|home|departure)", // "Columbus as the starting point"
    "(?:leaving|departing|depart)\\s+(?:from\\s+)?" + CITY,  // "leaving from Boise" / "departing Boise"
    "set off from\\s+" + CITY,                               // "set off from Boise"
    "kick off in\\s+" + CITY,                                // "kick off in Spokane"
    "launch point is\\s+" + CITY,                            // "launch point is Reno"
    "starting point is\\s+" + CITY,                          // "starting point is Austin"
    "begin in\\s+" + CITY,                                   // "begin in Tucson"
  ]
  // Words that are never a real city (pronouns, articles, time/season words). The
  // model sometimes writes "starting from your home base" (no city) or "departing
  // tomorrow" — these must NOT be treated as an asserted origin.
  const STOP = new Set([
    'home', 'your', 'you', 'where', 'there', 'here', 'the', 'a', 'an', 'that',
    'somewhere', 'it', 'we', 'i', 'today', 'tomorrow', 'soon', 'now', 'next',
    'this', 'spring', 'summer', 'fall', 'winter', 'early', 'late',
  ])
  for (const p of PATTERNS) {
    const m = text.match(new RegExp(p, 'i'))
    const cand = m && m[1] && m[1].trim()
    // Require the captured token to be a real proper noun (uppercase first letter)
    // and not a stopword. The 'i' flag lets the ANCHOR match any case (sentence-
    // initial or mid-sentence) while this check keeps CITY a proper noun.
    if (cand && /^[A-Z]/.test(cand) && !STOP.has(cand.toLowerCase())) {
      return cand
    }
  }
  return null
}

// ORIGIN-CAPTURE — deterministic extraction of an explicit route origin from the
// USER's own message (NOT the assistant reply — distinct from the
// extractAssertedOrigin guard above, which validates AI output post-response).
// When a user writes "create a trip from San Jose to Jacksonville" (or "to
// Jacksonville from san jose"), San Jose IS the origin (PRECEDENCE) — we capture
// it BEFORE the prompt is built so the no-home directive never fires and the
// model is never asked to referee. Returns the origin string (e.g. "San Jose" or
// "San Jose, CA"), title-cased if the user typed it lowercase, or null.
//
// Accepts BOTH word orders — "from X to Y" AND "to Y from X" — and lowercase /
// mixed-case origins ("san jose"). Conservative guards keep false captures rare
// (a missed capture just means the model asks for the origin — far safer than
// silently using a wrong one):
//   • origin's first token must not be a non-place word (pronoun, article,
//     time/idiom word) — rejects "from morning to night", "from work to …",
//     "from the coast to …", "from bad to worse", etc.
//   • PROPER-NOUN SIGNAL: at least one of origin/destination must contain a
//     capital letter (a real named place). This rejects all-lowercase idioms
//     ("from bad to worse", "from dawn to dusk") while still accepting the
//     common mixed-case phrasings ("to New Orleans from san jose").
// Common US city abbreviations → full city name. Applied to a deterministically
// captured origin so "KC → Bangor" stores "Kansas City", not "KC". Whole-token,
// case-insensitive; state omitted where ambiguous (the geocoder resolves it). The
// planner prompt resolves the rest conversationally.
const CITY_ABBREV: Record<string, string> = {
  kc: 'Kansas City', nyc: 'New York City', la: 'Los Angeles', sf: 'San Francisco',
  nola: 'New Orleans', slc: 'Salt Lake City', pdx: 'Portland, OR', dc: 'Washington, DC',
  vegas: 'Las Vegas', philly: 'Philadelphia',
}
function expandCommonAbbrev(s: string): string {
  const key = s.trim().toLowerCase().replace(/[.,]/g, '')
  return CITY_ABBREV[key] ?? s
}

export function extractFromXtoY(text: string | undefined | null): { origin: string; dest: string } | null {
  if (!text) return null
  const WORD = "[A-Za-z][A-Za-z.'-]*"
  const NOT_KW = "(?!(?:to|from)\\b)"            // a route keyword is never a city token
  const ORIGIN = `(${NOT_KW}${WORD}(?:\\s+${NOT_KW}${WORD}){0,3}(?:,\\s*[A-Za-z]{2,})?)`
  const DEST   = `(${NOT_KW}${WORD}(?:\\s+${NOT_KW}${WORD}){0,3})`

  let origin: string | null = null
  let dest: string | null = null
  let bareMatch = false                          // true only for the bare "X to Y" fallback
  let m = text.match(new RegExp(`\\bfrom\\s+${ORIGIN}\\s+to\\s+${DEST}`, 'i'))   // from X to Y
  if (m) { origin = m[1]; dest = m[2] }
  else {
    m = text.match(new RegExp(`\\bto\\s+${DEST}\\s+from\\s+${ORIGIN}`, 'i'))      // to Y from X
    if (m) { dest = m[1]; origin = m[2] }
  }
  if (!origin || !dest) {
    // Arrow shorthand: "X → Y" / "X -> Y" / "X —> Y" (route notation, no "from").
    // The STOP-word + proper-noun guards below still apply, so idioms are rejected.
    m = text.match(new RegExp(`${ORIGIN}\\s*(?:→|-+>|—+>)\\s*${DEST}`, 'i'))
    if (m) { origin = m[1]; dest = m[2] }
  }
  if (!origin || !dest) {
    // Bare "X to Y" — no "from", no arrow (e.g. "Kansas City to Bangor 3 nights
    // july7"). BUG-PLAN-ORIGIN-LOOP: clean route openers like this carry no route
    // keyword, so the deterministic net missed them and the planner re-asked for
    // the origin. This form is far more idiom-prone than the keyword forms ("I
    // want to go to Paris"), so it is gated hard: it must be the OPENING clause of
    // the message (^), and BOTH endpoints must carry a proper-noun capital
    // (enforced via bareMatch in Guard 2 below). The STOP-word guard rejects
    // verb/pronoun-led idioms ("Take me to Paris", "plan a trip to Miami").
    m = text.match(new RegExp(`^\\s*${ORIGIN}\\s+to\\s+${DEST}`, 'i'))
    if (m) { origin = m[1]; dest = m[2]; bareMatch = true }
  }
  if (!origin || !dest) return null
  origin = origin.trim()
  dest = dest.trim()
  // The DEST capture is greedy (up to 3 trailing words), so round-trip / filler
  // phrasing leaks in: "Bangor and back" / "Bangor for 3 nights" → the dest must
  // be just "Bangor" for the geocoder (and the pre-build budget check). Cut at the
  // first trailing connective — no US city name continues past one of these words.
  dest = dest.replace(/\s+(?:and|&|for|with|on|in|next|this|then|after|before|via)\b[\s\S]*$/i, '').trim()

  // Guard 1 — first origin token must not be a non-place word.
  const STOP = new Set([
    'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
    'january','february','march','april','may','june','july','august','september','october','november','december',
    'morning','noon','afternoon','evening','night','midnight','today','tomorrow','yesterday',
    'home','work','here','there','point','to','from','the','a','an','my','our','your',
    'now','time','start','finish','scratch','nowhere','everywhere','anywhere','somewhere',
    'it','this','that','bad','worse','dawn','dusk',
    // Idiom leading words — guard the bare "X to Y" fallback against verb/pronoun
    // openers and destination-only phrasings ("plan a trip to Miami", "Trip to
    // Miami"). Harmless to the keyword forms (none are real origins).
    'go','going','get','take','fly','flying','drive','driving','head','heading',
    'want','need','me','us','back','plan','travel','trip','flight','road',
  ])
  const firstTok = origin.split(/[\s,]+/)[0].toLowerCase()
  if (STOP.has(firstTok)) return null

  // Guard 2 — proper-noun signal. The keyword/arrow forms accept a capital on
  // EITHER side. The bare "X to Y" form has no "from"/arrow keyword anchoring it
  // as a route, so it is stricter: BOTH endpoints must carry a proper-noun
  // capital (rejects "I want to go to Paris", "san jose to jacksonville").
  if (bareMatch) {
    if (!/[A-Z]/.test(origin) || !/[A-Z]/.test(dest)) return null
  } else if (!/[A-Z]/.test(origin) && !/[A-Z]/.test(dest)) return null

  // Resolve a common abbreviation ("KC" → "Kansas City") before storing, so the
  // captured origin/destination are real cities the AI/geocoder use directly.
  // Both endpoints are returned: origin feeds capturedOrigin (BUG-PLAN-ORIGIN-LOOP),
  // dest feeds the deterministic destination capture (pre-build budget check).
  return {
    origin: normalizeOriginCase(expandCommonAbbrev(origin)),
    dest: normalizeOriginCase(expandCommonAbbrev(dest)),
  }
}

// Title-case an origin only when the user typed it all-lowercase ("san jose" →
// "San Jose"); a value the user already cased (or that carries a state code) is
// preserved verbatim. Keeps the captured origin tidy for the prompt directive.
function normalizeOriginCase(s: string): string {
  if (/[A-Z]/.test(s)) return s
  return s
    .split(',')
    .map((part, i) => {
      const p = part.trim()
      if (i > 0 && p.length === 2) return p.toUpperCase() // ", ca" → ", CA"
      return p.split(/\s+/).map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
    })
    .join(', ')
}

// Stored trip/stop dates are UTC-midnight Prisma DateTime values. Reading them
// with `new Date(d)` + local accessors (toLocaleDateString) shifts the calendar
// day back one in negative-offset deploy zones — the same artifact fixed in the
// weather flow (LAUNCH_STATUS #11). Route through parseTripDate (local-noon
// anchor on the UTC calendar day) first; local accessors then read the intended
// day regardless of process TZ. Output format is unchanged ("Jul 10, 2026").
// NOTE: only for STORED dates — a live `new Date()` (e.g. "Today") must NOT pass
// through here, since its correct value is the local calendar day, not the UTC one.
function fmtDate(d: string | Date | null | undefined): string {
  const parsed = parseTripDate(d)
  if (!parsed) return 'not set'
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Reduces a TravelParty (with people + pets included) to the supplementary
 *  shape the AI prompts will see in their JSON context. Phase A only plumbs
 *  the read path — old TravelProfile fields stay primary until Phase C. */
function serializeParty(party: any | null) {
  if (!party) return null
  return {
    notes: party.notes ?? null,
    people: (party.people ?? []).map((p: any) => ({
      role: p.role,
      name: p.name,
      age: p.age,
      isTraveling: p.isTraveling,
      isEmergencyContact: p.isEmergencyContact,
      accessibilityNeeds: p.accessibilityNeeds,
      dietaryNotes: p.dietaryNotes,
      militaryStatus: p.militaryStatus,
      firstResponder: p.firstResponder,
    })),
    pets: (party.pets ?? []).map((p: any) => ({
      type: p.type,
      name: p.name,
      breed: p.breed,
      weightLbs: p.weightLbs,
      leashTrained: p.leashTrained,
      comfortableInCrowds: p.comfortableInCrowds,
      comfortableAtNight: p.comfortableAtNight,
      notes: p.notes,
    })),
  }
}

/** Builds a compact live-state system message for the modify flow.
 *  Injected before every Claude call so the AI always sees the actual stop list,
 *  not just what it remembers from conversation history. */
function buildLiveTripState(trip: any, rigs: any[] = []): string {
  const stops: any[] = trip.stops ?? []
  const stopNames = stops.map((s: any) => s.locationName.toLowerCase())

  // User-facing vocabulary, computed from the data model.
  // - HOME entry (data: order 1, type HOME) is the "Starting point" — NOT "Stop 1"
  // - On loop trips, the closing return-home entry (last stop, type DESTINATION,
  //   nights 0, locationName matches HOME) is the "Return home" — NOT "Stop N"
  // - Destinations between are renumbered "Stop 1..N" for the user, where Stop 1
  //   is the first destination AFTER home.
  // MODIFY-ANCHOR-1: the model is shown ONE number (the user-facing "Stop N") and
  // the NAME per line — the raw `order` is deliberately NOT printed, because showing
  // two competing numbers made the model conflate them (it miscounted "stop 7" by
  // one). The model anchors <modify> actions on the bracket stop's NAME (after_stop),
  // which the client resolver matches; the numeric order stays internal to the data.
  const homeStop = stops.find((s: any) => s.type === 'HOME')
  const lastStop = stops.length > 0 ? stops[stops.length - 1] : null
  const isReturnHome = (s: any) =>
    homeStop &&
    s !== homeStop &&
    s === lastStop &&
    s.locationName?.toLowerCase().trim() === homeStop.locationName?.toLowerCase().trim()

  // Trip shape — frames the stop list for the AI so it never hallucinates a
  // return-to-home leg that does not exist in the data. Loop = closing return-
  // home stop present; one-way = no return-home; neither = no home stop at all
  // or the trip has only the home entry.
  //
  // BUG-4 Phase 3 — prefer the persisted Trip.tripType (written at creation)
  // over re-inferring shape from stops. Legacy trips have tripType == null and
  // fall back to the original stop-shape inference (isReturnHome on the last
  // stop), reproducing the prior behavior EXACTLY. The structural guard
  // (a HOME stop + a distinct last stop) still gates whether we emit a shape
  // block at all — unchanged, and it keeps the homeName/lastStop refs in the
  // block below from dereferencing null even when tripType is set.
  const hasShapeableStops = !!(homeStop && lastStop && lastStop !== homeStop)
  // Shape fallback uses the shared computeTripShape helper (single source of
  // truth, also used by the modify-path write in trips.ts syncTripEndpoints).
  // Gated by hasShapeableStops so behavior is unchanged: when a HOME stop +
  // distinct last stop exist, computeTripShape's home anchor IS that HOME stop,
  // so this equals the prior isReturnHome(lastStop) check. (isReturnHome is
  // kept below for the per-stop "Return home" labeling.)
  const isLoopByShape = hasShapeableStops && computeTripShape(stops) === 'ROUND_TRIP'
  const loopFromTripType =
    trip.tripType === 'ROUND_TRIP' ? true :
    trip.tripType === 'ONE_WAY'   ? false :
    isLoopByShape // null (legacy) → original stop-shape inference
  const isLoopTrip = !!(hasShapeableStops && loopFromTripType)
  const isOneWayTrip = !!(hasShapeableStops && !loopFromTripType)

  let tripShapeBlock: string | null = null
  if (isLoopTrip) {
    const homeName = homeStop.locationName
    tripShapeBlock =
      `**Trip shape**: This is a ROUND TRIP. The user departs from ${homeName} ` +
      `and returns to ${homeName} at the end. The "Return home" stop is the ` +
      `trip's closing stop.`
  } else if (isOneWayTrip) {
    const homeName = homeStop.locationName
    tripShapeBlock =
      `**Trip shape**: This is a ONE-WAY TRIP. The user departs from ${homeName} ` +
      `and the trip ENDS at ${lastStop.locationName}. There is NO return-home leg. ` +
      `Do NOT assume the user drives back to ${homeName} after the last stop. ` +
      `If the user wants to convert this into a round trip, they must explicitly ` +
      `ask you to add a return-home stop — see the \`add_stop\` examples below ` +
      `for the correct shape.`
  }

  let userFacingIdx = 0
  const stopLines = stops.map((s: any) => {
    const name = s.locationState ? `${s.locationName}, ${s.locationState}` : s.locationName
    let userLabel: string
    if (s.type === 'HOME') {
      userLabel = 'Starting point'
    } else if (isReturnHome(s)) {
      userLabel = 'Return home'
    } else {
      userFacingIdx += 1
      userLabel = `Stop ${userFacingIdx}`
    }
    const parts = [
      `${userLabel}: ${name}`,
      s.type,
      `${s.nights} night${s.nights !== 1 ? 's' : ''}`,
      s.bookingStatus,
    ]
    if (s.campgroundName) parts.push(`campground: ${s.campgroundName}`)
    // BUG-MODIFY-ADDSTOP-SEQUENCE — surface each stop's coordinates so the model
    // can obey the on-route add_stop placement rule for unfamiliar towns (it was
    // guessing geography from names alone). Omit the clause when coords are
    // missing rather than printing "(undefined)".
    if (typeof s.latitude === 'number' && typeof s.longitude === 'number') {
      parts.push(`(${s.latitude.toFixed(3)}, ${s.longitude.toFixed(3)})`)
    }
    return parts.join(' | ')
  })

  // Trip.startDate / Trip.endDate are typically null in this codebase — the
  // promote flow only writes startLocation/endLocation/totalMiles/etc. The
  // canonical trip-bounds anchor is the first/last stop with a non-null
  // arrival/departure date (matches TripSummaryPage's buildTimeline). Fall
  // back to the Trip columns first in case a future write does populate them,
  // then to stops, and finally fmtDate handles null gracefully ("not set").
  const firstStopArrival = stops.find((s: any) => s.arrivalDate != null)?.arrivalDate
  const lastStopDeparture = [...stops].reverse().find((s: any) => s.departureDate != null)?.departureDate
  const effectiveStart = trip.startDate ?? firstStopArrival
  const effectiveEnd = trip.endDate ?? lastStopDeparture

  // RIG-CHANGE Phase 3 — the user's saved rigs, rendered for the change_rig
  // action so the model can map "the Allegro Bus" / "the bigger rig" to a real
  // rigId. Display name mirrors rigDisplayName: "[year] [make] [model]" else the
  // vehicleType. Empty list → change_rig has no valid target (handled in-prompt).
  const rigLines: string[] = (rigs ?? []).map((r: any) => {
    const nm = [r.year, r.make, r.model].filter(Boolean).join(' ').trim() || r.vehicleType
    const len = r.length != null ? `${r.length}ft` : 'length n/a'
    return `  - ${nm} | ${len} | ${r.vehicleType}${r.isDefault ? ' | (profile default)' : ''} | rigId: ${r.id}`
  })

  return [
    '=== MODIFY MODE — TRIP MODIFICATION INSTRUCTIONS ===',
    '',
    'CRITICAL: You are in trip MODIFY mode. The user is editing an existing trip.',
    'This trip ALREADY has an origin, a start date, and a total length (see Route / Dates / Total nights below). In MODIFY mode you must NEVER ask the user when they\'re leaving, where they\'re starting from, or how many nights total — those are already set. Ignore any base-prompt planning/opening-flow rules that ask for them. Just propose the <modify> actions for what they asked to change.',
    'Every trip modification you agree to perform MUST include a <modify>…</modify> JSON block.',
    'If you say you are adding, removing, or changing something but do NOT emit a <modify> tag,',
    'NO change actually happens — the UI has no other way to apply modifications.',
    'Never say "Applied to trip", "Done!", "Added!", or any confirmation phrase without also emitting the <modify> tag.',
    'If you cannot determine all required parameters, ask the user — do not claim to have done it.',
    'MULTI-STEP CHANGES (AI-MESA-10 contract): when the user\'s request requires SEVERAL changes (e.g. adding multiple stops for a return route), emit ONE <modify> block PER change, in execution order, each on its own line. Every block is a SEPARATE PROPOSAL — the user must click Apply on each one individually, in order. NOTHING you emit is ever applied automatically.',
    'NEVER claim a change has been applied. Changes happen ONLY after the user clicks Apply in the UI. Never write "[✓ change already applied]", "[✓ applied]", "[applied]" or any similar bracketed marker yourself — those markers are added by the SYSTEM to past turns based on verified apply state, and writing one yourself is a serious honesty violation (it will be stripped, and the user will see a claim with no change). If a past turn of yours shows "[proposal — NOT applied…]", that change never happened — do not assume or assert it did.',
    'CLARIFYING QUESTIONS: When you need more information from the user before you can propose a change (e.g. they have not said WHICH existing stop they mean, or how many nights for a stop they are ADDING), DO NOT emit a <modify> tag. Instead, wrap your ENTIRE clarifying reply in a <clarify>…</clarify> tag — e.g. <clarify>Which stop did you mean — Stop 1 or Stop 2?</clarify>. The user sees only the text inside the tag, so write a normal, friendly question there. NEVER use a clarifying question to ask for trip-level details that already exist — the start date, the origin, or the total trip length are fixed (shown below); do not ask for them. Emit <modify> blocks ONLY when proposing actionable changes; emit <clarify> ONLY when asking for information you still need. Never emit both in the same reply, and never neither — every modify-mode reply is either one-or-more <modify> blocks or exactly one <clarify>.',
    '',
    'USER VOCABULARY — read carefully:',
    'Each line in the stop list below shows a user-facing label ("Starting point" / "Stop N" / "Return home") and the stop NAME, e.g. "Stop 2: [EXAMPLE_STOP_2], [STATE]". Reference stops by NAME — the name is the reliable anchor; the "Stop N" number is only there to match the user\'s own wording:',
    '- When TALKING TO THE USER in prose, refer to stops by their user-facing label and locationName (e.g. "I\'ll remove [EXAMPLE_STOP_1]" or "before your starting point" or "after Stop 2"). NEVER say "stop 1" to mean the home departure.',
    '- When EMITTING <modify> JSON, identify any existing stop by its locationName from the list ([EXAMPLE_STOP_1], [EXAMPLE_STOP_2], etc.). For add_stop, anchor the insertion with after_stop set to the EXACT locationName of the stop the new one goes AFTER (see the add_stop format below) — names are the reliable anchor, not stop numbers.',
    '- When the user says "first stop" / "stop 1" / "the second stop" / "the last stop", they almost always mean a NUMBERED DESTINATION — not the home departure and not the return-home entry. If the request is ambiguous, ASK BEFORE EMITTING a <modify> tag: "Just to confirm — you mean [first destination], not your home departure?"',
    '- Concrete example: trip is "Starting point: [HomeCity] | Stop 1: [EXAMPLE_STOP_1] | Stop 2: [EXAMPLE_STOP_2] | Return home: [HomeCity]". User says "remove the first stop" → that means [EXAMPLE_STOP_1], not [HomeCity]. Confirm with the user, then emit <modify>{"action":"remove_stop","locationName":"[EXAMPLE_STOP_1]"}</modify>.',
    '',
    'DRIVE LIMIT TAG (FEAT-TRIP-DRIVE-CAP): If the user states a daily drive-time limit for this trip ("keep drive days under 4 hours", "no more than 5 hours a day", "max 300 miles a day" → convert miles to hours at 55 mph and round to the nearest half hour), acknowledge it in ONE plain sentence ("Got it — I\'ll keep drive days under 4 hours for this trip") and append a machine tag on its OWN line at the very END of your reply: <drive_cap>4</drive_cap> (a number of hours, 1–16, decimals allowed). Emit it once per stated limit. Do NOT emit it for hypotheticals or questions ("what if we did 4 hours?"). The app stores it, re-measures every leg against it, and adds any overnight stops itself — do not propose transit stops for it. A drive-limit statement on its own needs NO <modify> block and NO <clarify> tag: the acknowledgement sentence plus the <drive_cap> tag IS the complete reply. Only add <modify> blocks if the user ALSO asked for a stop/route change in the same message.',
    '',
    'PET TAG (FEAT-PET-CAPTURE): If the user says THEIR OWN pet is coming on this trip ("we\'re bringing Callie, our golden retriever", "traveling with our two cats", "the dog is coming"), and that pet is NOT already in the travel party shown in the JSON context, append one machine tag per pet on its OWN line at the very END of your reply: <pet>TYPE|Name|Breed</pet> where TYPE is exactly DOG, CAT, or OTHER; Name and Breed may be blank but keep the | separators (e.g. <pet>DOG|Callie|Golden Retriever</pet>, <pet>CAT||</pet>). Acknowledge in one short sentence ("Got it — I\'ll plan with Callie along"). Do NOT emit it for someone else\'s pet, a hypothetical, or a pet the user says is staying home. A pet statement on its own needs NO <modify> block and NO <clarify> tag. The tag is stripped before the user sees your message.',
    '',
    'DRIVE-TIME — THE APP HANDLES IT, NOT YOU: After ANY change you propose (add, remove, reorder, return-home), the app measures REAL drive times and automatically inserts any overnight transit stop a new or merged leg needs, then tells the user about it. So: do NOT propose, add, or emit OVERNIGHT_ONLY / transit stops in a <modify> (no transit stop in add_stop, none "along the way") — just propose the destination change the user asked for. And do NOT tell the user that a leg "stays within" / "is over" / "fits" their drive-time limit, how many hours or miles a leg is, or that you checked/verified drive times — your estimate is not authoritative. Reproduce any OVERNIGHT_ONLY stops already in the live trip unchanged; never invent new ones.',
    '',
    'TRAVEL PARTY — HARD RULE: The trip-scoped `party` (in the JSON context below, when present) or the user\'s `defaultParty` describes who is traveling. Trip-scoped overrides user-level. You MUST consult party data when proposing modifications.',
    '  PEOPLE',
    '  - For each Person with isTraveling=true: count them in the party size. Use this for campground capacity, site recommendations, and activity suggestions.',
    '  - Persons with isTraveling=false (typically with isEmergencyContact=true) are NOT on the trip — never count them in party size or include them in trip-context narration.',
    '  - If any Person has accessibilityNeeds set (JSON with flags like wheelchair, paved_path, accessible_restroom, near_facility, level_site, low_elevation), filter campground suggestions to ADA/accessible sites and avoid steep or rough-terrain stops. When you recommend or filter sites based on accessibility needs, add a brief note telling the user to confirm specific accessibility/ADA details directly with the campground, since reported accessibility data can be incomplete or out of date.',
    '  - If any Person has dietaryNotes (e.g. "gluten-free", "kosher"), prefer stops near grocery stores or restaurants that can accommodate.',
    '  - If any Person has role=CHILD or INFANT, prefer family-friendly campgrounds, suggest age-appropriate activities, and avoid adult-only RV resorts.',
    '  - militaryStatus and firstResponder on a Person are informational; do NOT use them to gate suggestions (the campground access endpoint handles that separately at the account-holder level).',
    '  PETS',
    '  - If pets array is non-empty: ONLY suggest pet-friendly campgrounds when proposing campground swaps. Mention that you\'ve filtered for pet-friendly options.',
    '  - Pet weightLbs > 50: avoid campgrounds with small-dog-only or weight-limit policies; mention "large-dog-friendly" explicitly when relevant.',
    '  - leashTrained=false on any pet: prefer campgrounds with fenced sites or dog runs; avoid sites that strictly require leashing.',
    '  - comfortableInCrowds=false on any pet: avoid busy resorts, prefer quieter / state-park-style campgrounds.',
    '  - comfortableAtNight=false on any pet: prefer sites with low ambient noise, not near generators or main roads.',
    '  - Pet `notes` (free-form) may contain medical or behavioral info — read it, factor it in, but DO NOT regurgitate sensitive info back to the user unless they bring it up first.',
    '  EMERGENCY CONTACTS',
    '  - Persons with isEmergencyContact=true are stored for emergencies. Do NOT include them in trip planning suggestions or party-size counts.',
    '  FALLBACK BEHAVIOR',
    '  - If both trip.party and defaultParty are null AND the legacy travelProfile fields (adults, children, hasPets) are populated, fall back to those. Transition state until Phase C removes the legacy fields.',
    '  - If both party and legacy fields are null/zero, ask the user before emitting a <modify> that depends on party composition.',
    '  NEVER LEAK SCHEMA — when narrating to the user, say "your dog" or "your two adults and a kid", not "your party has 1 pet of type DOG with leashTrained=true." The schema fields are inputs to your reasoning; the output is plain conversational English.',
    '',
    'SUPPORTED ACTIONS AND JSON FORMAT:',
    '',
    'Add a stop:',
    '<modify>{"action":"add_stop","locationName":"[EXAMPLE_DESTINATION_CITY]","locationState":"[STATE]","type":"DESTINATION","nights":1,"after_stop":"[EXAMPLE_STOP_1]"}</modify>',
    '  after_stop (PRIMARY anchor): the EXACT locationName of the existing stop the new stop goes AFTER — copy it verbatim from the stop list (e.g. "after_stop":"[EXAMPLE_STOP_1]"). ALWAYS include after_stop when inserting relative to an existing stop. Omit it only to append at the very end of the trip.',
    '  Resolve references to NAMES first: when the user references a stop by number ("stop 7", "between 7 and 8"), map that number to the NAMED stop on the list and use the NAME in both your confirming question AND after_stop — e.g. user "between 7 and 8" (Stop 7 = [EXAMPLE_STOP_1], Stop 8 = [EXAMPLE_STOP_2]) → you confirm "between [EXAMPLE_STOP_1] and [EXAMPLE_STOP_2]" and emit "after_stop":"[EXAMPLE_STOP_1]". You MAY also include afterStopOrder as a numeric hint, but after_stop (the name) is authoritative.',
    '  nights parsing rules: "one night" = 1 | "two nights" or "a couple nights" = 2 | "three nights" = 3 | "a few nights" = 2 | "the weekend" = 2 | "three days" = 3 (treat N days as N nights) | default to 1 if ambiguous. Parse nights EXACTLY as stated — do not infer or round up.',
    '  date-range rule: if a stay is given as a date range (a check-in date to a check-out date), nights = the number of nights between them = the count of calendar days from check-in up to but NOT including check-out. The check-out day is not a night. Example: check-in on a date and check-out nine days later is 9 nights.',
    '  POSITION + GEOGRAPHY — HARD RULE: inserting "after [stop A]" places the new stop BETWEEN [stop A] and the stop that currently follows it ([stop B]) — the new stop slots in right after [stop A], and [stop B] (and everything after it) shifts one position later. Set after_stop to [stop A]\'s name.',
    '  The added stop — whether the USER named it or YOU were asked to pick it — MUST lie geographically ON THE ROUTE between [stop A] and [stop B]. It must NOT sit past [stop B], and must NEVER force a backtrack (driving beyond [stop B] and then doubling back to it). Compare the candidate against the locations of BOTH bracketing stops: if it is farther along the route than [stop B], or so far off to the side that reaching it adds a there-and-back detour, it is the WRONG choice — use a city that genuinely falls on the leg from [stop A] to [stop B].',
    '  USE THE COORDINATES: each stop in the list above carries its (lat, lng). Look up the NEW stop\'s real-world coordinates and compare them against those of the existing stops to choose after_stop, so the new stop slots between the two stops it is geographically BETWEEN along the route — not merely after whichever stop the user happened to mention. A town that lies west/behind an earlier stop belongs EARLIER in the sequence (set after_stop to the stop it actually follows geographically), never wedged between two later stops it would force a backtrack through.',
    '  When the user defers the choice to you ("you pick", "pick a place", "surprise me") for an after-[stop A] insertion, choose a sensible overnight city sitting roughly on the straight line between [stop A] and [stop B] — a midpoint of THAT specific leg. Anchor your choice ONLY on the locations of [stop A] and [stop B]; do NOT anchor on the overall trip direction, the final destination, or any later stop.',
    '  EXCEPTION: if [stop A] is the LAST stop (nothing currently follows it), nothing brackets the new stop on the far side — normal "extend the trip toward a new destination" behavior applies, and you may omit after_stop to append at the end. The between-stops constraint is the only new rule.',
    '',
    'Add a return-home stop (converts a one-way trip into a round trip):',
    '<modify>{"action":"add_stop","locationName":"[HomeCity]","locationState":"[HomeState]","type":"HOME","nights":0}</modify>',
    '  Use type "HOME" and nights 0 only when adding a closing return-home leg.',
    '  locationName MUST match the user\'s home city (homeName in the trip context).',
    '  Omit afterStopOrder so it appends at the end.',
    '  ROUND-TRIP / RETURN-HOME ON MODIFY — INFER this from the user\'s NATURAL LANGUAGE; do NOT gate it on a fixed exact-phrase list. If the user\'s words mean the trip should END BACK at its starting point — e.g. "make it a round trip", "come home" / "coming home", "head back" / "head home", "and back", "there and back", "out and back", "loop", "round trip it", "back to [origin city]", or ANY plain-English equivalent that expresses returning to the origin — AND the trip is currently one-way (no return-home closer in the stop list), you MUST emit the add_stop HOME tag above, appending the return-home stop at the END (type "HOME", nights 0, locationName = the user\'s home city). Confirm in prose AND emit the tag — saying "I\'ll add the return home" WITHOUT the <modify> tag does nothing (see the top-of-instructions rule). OPPOSITE GUARD: do NOT add a return-home leg when the user explicitly wants a one-way trip ("one way", "no return", "not a round trip", "I\'m moving to [dest]", "relocating to [dest]"), and do NOT invent one when the request is genuinely ambiguous. Dates alone do NOT imply a round trip. Decide from the user\'s MEANING, not from whether an exact phrase appears.',
    '',
    'Convert a round trip to one-way (remove the return-home leg):',
    '<modify>{"action":"make_one_way"}</modify>',
    '  Use when the trip is currently a ROUND TRIP (it ends back at the starting city) and the user wants it ONE-WAY — "make it one-way", "no return", "don\'t go back home", "drop the trip home", "one way", or any plain-English equivalent. This SINGLE action removes the trailing return-home stop AND the return-leg transit overnights in one shot, ending the trip at the farthest destination. Do NOT emit remove_stop for the return-home stop or its transit overnights — use this action instead. No locationName or other fields needed. If the trip is already one-way, do not emit it.',
    '',
    'Remove a stop:',
    '<modify>{"action":"remove_stop","locationName":"[EXAMPLE_DESTINATION_CITY]"}</modify>',
    '',
    'Change nights at a stop:',
    '<modify>{"action":"change_nights","locationName":"[EXAMPLE_DESTINATION_CITY]","nights":3}</modify>',
    '',
    'Change / replace a destination (e.g. "change my destination to X", "go to X instead of Y", "make the end Z"): emit two proposals — remove_stop for the destination being replaced, then add_stop for the new one — reusing the replaced stop\'s existing nights. Anchor add_stop with after_stop = the stop that preceded the replaced one (omit after_stop to append if it was the last stop). Do NOT ask for nights, dates, or origin — carry over what the trip already has. EXCEPTION — if the stop being replaced is the STARTING POINT (the first stop / departure), do NOT use remove_stop + add_stop: the departure stop is structurally protected and remove_stop will be REJECTED. Use change_start below instead.',
'',
'Change the STARTING point (MODIFY-CHANGE-START — e.g. "start from X instead", "I wanted to leave from X", "the starting point is wrong", or the user says the trip begins at the wrong place):',
'<modify>{"action":"change_start","locationName":"[EXAMPLE_DESTINATION_CITY]","locationState":"[STATE]"}</modify>',
'  This ONE action relocates the existing departure stop in place — never emit remove_stop for the starting point (it is protected and will fail). Nights, dates, and every other stop are untouched; the app re-measures drive times and re-inserts any needed overnight automatically.',
'  AMBIGUOUS PLACE NAMES: some place names exist in more than one location (the exact failure this action exists to fix). Emit the MOST SPECIFIC, disambiguated locationName the user\'s words support — a nearby town, the full landmark name, or "Landmark, Nearest Town" (e.g. "Kennedy Meadows Pack Station, Pinecrest" rather than a bare "Kennedy Meadows") — and always include locationState. If the user\'s wording leaves WHICH place genuinely unclear, ask ONE clarifying question before emitting the action.',
    '',
    'Suggest a campground at a stop:',
    '<modify>{"action":"suggest_campground","locationName":"[EXAMPLE_DESTINATION_CITY]","campgroundName":"[EXAMPLE_CAMPGROUND_1]"}</modify>',
    '',
    'Shift the entire trip to a new start date:',
    '<modify>{"action":"shift_trip_dates","newStartDate":"2026-08-09"}</modify>',
    '  Use this when the user wants to move the WHOLE trip forward or backward in time (e.g. "push trip to August 9", "start two weeks later", "move trip back to next month", "delay until after Labor Day"). Every stop shifts by the same delta. Trip length and per-stop nights are preserved automatically — do NOT also emit change_nights when shifting dates.',
    '  newStartDate format: ISO date string YYYY-MM-DD. If the user gives a relative date ("two weeks later", "first weekend of September"), resolve it to an absolute YYYY-MM-DD against today (see the Today line in the trip context below) before emitting.',
    '  Avoid emitting a past newStartDate unless the user explicitly asks to backdate the trip (e.g. for completed-trip record-keeping). When in doubt, ask the user to confirm before emitting.',
    '  Do NOT use this action for changing the length of a single stop — use change_nights for that.',
    '',
    'Change the rig (RV / vehicle) used for THIS trip:',
    '<modify>{"action":"change_rig","rigId":"<EXACT id from YOUR RIGS below>","rigName":"<that rig\'s display name>"}</modify>',
    '  Use when the user asks to change / switch the rig, RV, camper, motorhome, trailer, or vehicle for this trip (e.g. "use my Allegro Bus", "switch to the bigger rig", "change my RV to the 40-footer", "plan this for the van instead").',
    '  rigId MUST be copied EXACTLY from the YOUR RIGS list below — never invent or guess an id. rigName is that rig\'s display name (shown to the user on the confirmation card).',
    '  Match the user\'s words to a rig by make / model / year / length / type against YOUR RIGS, and emit change_rig ONLY when you can confidently identify the ONE rig they mean.',
    '  If you CANNOT identify which rig — the wording is ambiguous, the named rig is not in YOUR RIGS, or there is only one (or zero) rig on file so there is nothing to switch to — do NOT guess and do NOT emit change_rig. Instead wrap this exact sentence in a <clarify> tag: "You can change the rig for this trip on the trip page using the \'Rig for this trip\' selector." NEVER tell the user that changing the rig is "not supported".',
    '  Booked stops are NEVER altered by a rig change — the system keeps every reservation and flags any that need re-verifying with the campground. Do not claim a booking changed.',
    '',
    'YOUR RIGS (the user\'s saved rigs — the ONLY valid change_rig targets; copy rigId verbatim):',
    ...(rigLines.length ? rigLines : ['  (none on file — do NOT emit change_rig; if asked, give the trip-page selector fallback above)']),
    ...(rigLines.length === 1 ? ['  NOTE: only one rig on file — there is nothing to switch to. If asked to change the rig, give the trip-page selector fallback, do not emit change_rig.'] : []),
    '',
    'EXAMPLE — correct assistant response when user says "Add [EXAMPLE_DESTINATION_CITY] for one night after [EXAMPLE_STOP_2]":',
    'Sure! I\'ll add [EXAMPLE_DESTINATION_CITY], [STATE] for one night after [EXAMPLE_STOP_2].',
    '<modify>{"action":"add_stop","locationName":"[EXAMPLE_DESTINATION_CITY]","locationState":"[STATE]","type":"DESTINATION","nights":1,"after_stop":"[EXAMPLE_STOP_2]"}</modify>',
    '',
    'EXAMPLE — correct assistant response when user says "Make it a round trip" on a one-way trip starting at [HomeCity]:',
    'Sure! I\'ll add the return home to [HomeCity] at the end so the trip loops back to where you started.',
    '<modify>{"action":"add_stop","locationName":"[HomeCity]","locationState":"[HomeState]","type":"HOME","nights":0}</modify>',
    '',
    'EXAMPLE — correct assistant response when user says "Push the trip to start August 9th":',
    'Sure! I\'ll shift the whole trip so it starts August 9th. Your stop count and per-stop nights stay the same.',
    '<modify>{"action":"shift_trip_dates","newStartDate":"2026-08-09"}</modify>',
    '',
    'EXAMPLE — correct assistant response when user says "Switch this trip to my Allegro Bus" (and YOUR RIGS lists an Allegro Bus):',
    'Sure! I\'ll switch this trip to your Allegro Bus. Your booked stops stay exactly as they are — I\'ll just flag any that are worth a quick re-check with the campground for the new rig size.',
    '<modify>{"action":"change_rig","rigId":"<the Allegro Bus rigId from YOUR RIGS>","rigName":"Allegro Bus"}</modify>',
    '',
    'EXAMPLE — correct MULTI-STEP response when user says "Route me home with overnight stops along the way":',
    'Here\'s a return route home within your drive limit — three stops, each a separate change for you to apply:',
    '<modify>{"action":"add_stop","locationName":"[EXAMPLE_STOP_1]","locationState":"[STATE]","type":"OVERNIGHT_ONLY","nights":1,"after_stop":"[EXAMPLE_STOP_2]"}</modify>',
    '<modify>{"action":"add_stop","locationName":"[EXAMPLE_STOP_2]","locationState":"[STATE]","type":"OVERNIGHT_ONLY","nights":1,"after_stop":"[EXAMPLE_STOP_1]"}</modify>',
    '<modify>{"action":"add_stop","locationName":"[HomeCity]","locationState":"[HomeState]","type":"HOME","nights":0}</modify>',
    'Apply them in order and your return route is set. (Note: NO claim that anything was applied — the user decides.)',
    '',
    'STOP LIST RULES (GROUND TRUTH):',
    '1. The stop list below is the ONLY authoritative source of what stops currently exist.',
    '2. Do NOT say "I already added [stop]" based on conversation history. Only trust this list.',
    '3. If a stop does not appear below, it does NOT exist on this trip — regardless of anything said earlier.',
    `4. If the user asks to add a stop whose name matches one already in the list (${stopNames.join(', ') || 'none'}), do NOT emit a <modify> tag. Instead tell the user it is already on the trip.`,
    '5. Before generating any <modify> tag, verify the requested stop is not already in the list below.',
    '6. If the user references a stop that is NOT in the list, do NOT guess or substitute a different stop (a wrong swap is worse than asking). Emit ONE short <clarify> naming the closest existing stop — e.g. <clarify>I don\'t see [requested] on this trip — did you mean [closest existing stop]?</clarify> — and nothing else.',
    '',
    `Trip: ${trip.name}`,
    `Route: ${trip.startLocation} → ${trip.endLocation}`,
    `Dates: ${fmtDate(effectiveStart)} – ${fmtDate(effectiveEnd)}`,
    // Today's date is injected so shift_trip_dates can resolve relative
    // user phrases ("two weeks later", "next month") to an absolute
    // YYYY-MM-DD before emitting the <modify> tag. This is a live instant,
    // not a stored UTC-midnight date, so it is formatted with local accessors
    // directly (NOT via fmtDate/parseTripDate) — the user's "today" is their
    // local calendar day, which would be shifted forward in the evening of a
    // negative-offset zone if read as the UTC day.
    `Today: ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    `Total nights: ${trip.totalNights ?? 'not set'}`,
    '',
    ...(tripShapeBlock ? [tripShapeBlock, ''] : []),
    'Current stops in order:',
    stopLines.length ? stopLines.join('\n') : '(no stops yet)',
    // Phase A: trip-scoped Travel Party plumbed into modify-mode prompt as
    // supplementary JSON context. No new instructions yet — those land after
    // the UI is built. trip.party is null for legacy trips and will populate
    // once trip-creation cloning lands.
    ...(trip.party
      ? ['', 'Trip travel party (JSON):', JSON.stringify(serializeParty(trip.party))]
      : []),
    // Planning-context continuity: the original PlanningSession transcript
    // distilled to ~250 words of prose. Generated once at promote time
    // (lazily backfilled in chat() for legacy trips before this string is
    // built) so the modify assistant doesn't ask the user to re-explain
    // preferences they already shared during planning.
    ...(trip.planningContextSummary
      ? [
          '',
          'PLANNING CONTEXT (from the user\'s original planning conversation):',
          trip.planningContextSummary,
          '',
          'Use this context to understand the user\'s preferences and avoid asking them to re-explain things they\'ve already shared. If their modify request conflicts with something they said during planning (e.g. they originally avoided mountain passes but now ask to add a stop that requires one), gently flag the conflict.',
        ]
      : []),
    '=== END MODIFY MODE INSTRUCTIONS ===',
  ].join('\n')
}

/** Deterministic backstop for requested-nights capture: pull an EXPLICIT
 *  integer duration ("6 days", "10 nights", "3-day") from a user message. "N
 *  days" maps to N nights (mirrors the DURATION CONFIRMATION prompt rule).
 *  Explicit digits ONLY — fuzzy lengths ("a couple weeks") are deliberately left
 *  to the model's <requestedNights> tag, so this never guesses. Nights phrasing
 *  wins over days when both appear. Returns null when no explicit duration. */
function parseExplicitNights(text?: string | null): number | null {
  if (!text) return null
  const t = text.toLowerCase()
  const nightM = t.match(/\b(\d{1,3})\s*-?\s*nights?\b/)
  if (nightM) {
    const n = Number(nightM[1])
    if (Number.isInteger(n) && n > 0 && n <= 365) return n
  }
  const dayM = t.match(/\b(\d{1,3})\s*-?\s*days?\b/)
  if (dayM) {
    const n = Number(dayM[1])
    if (Number.isInteger(n) && n > 0 && n <= 365) return n
  }
  return null
}

/** Builds the targeted "still need X" reply for the WHERE/WHEN/LENGTH build gate.
 *  Names ONLY the missing essential(s); when several are missing they're asked
 *  together in one message. Contains no <itinerary>, so the client shows no Build
 *  button. */
function buildGateAsk(whereOk: boolean, whenOk: boolean, lengthOk: boolean): string {
  const needs: string[] = []
  if (!whereOk) needs.push('where you want to go')
  if (!whenOk) needs.push("a start date (a rough month is fine — I'll pin a specific day)")
  if (!lengthOk) needs.push('how many nights you want')
  const list =
    needs.length <= 1
      ? needs[0] ?? 'a few details'
      : needs.length === 2
        ? `${needs[0]} and ${needs[1]}`
        : `${needs.slice(0, -1).join(', ')}, and ${needs[needs.length - 1]}`
  const those = needs.length > 1 ? 'those' : 'that'
  return `Before I map this out, I just need ${list}. Share ${those} and I'll build your itinerary right away.`
}

/** BUG-2 — refuse-and-ask when the MINIMAL trip can't fit the user's stated
 *  total-nights budget. Names the turnaround, states the specific minimum, and
 *  offers to set it. No itinerary, so nothing builds until the user resolves it. */
/** FEAT-PLANNER-FACTS — explicit stop count the user asked for ("four stop
 *  trip", "3 stops", "a 5-stop loop"). Digits or number words up to twelve;
 *  null when nothing explicit was said. Scanned across ALL user turns so the
 *  count survives history truncation; the LAST mention wins. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}
function parseRequestedStops(userMessages: string[]): number | null {
  let found: number | null = null
  for (const msg of userMessages) {
    const t = String(msg ?? '').toLowerCase()
    const re = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]*stops?\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(t))) {
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]]
      if (Number.isInteger(n) && n > 0 && n <= 30) found = n
    }
  }
  return found
}

/** FEAT-PLANNER-FACTS — the fact block the planner reads before it writes.
 *  Every number here was measured by the app; the prompt rule makes them
 *  authoritative. Kept short and literal so it survives being quoted. */
function buildDriveFactsBlock(
  f: DriveFacts,
  requestedNights: number | null,
  requestedStops: number | null,
  lastOverBudget: { legFrom: string; legTo: string; legHours: number; addedNights: number; total: number } | null,
): string {
  const shape = f.roundTrip ? 'round trip' : 'one-way'
  const lines: string[] = []
  lines.push(`Core drive ${f.originName} → ${f.destName} (${shape}): ${f.miles} mi, about ${f.driveHours} h of driving each way.`)
  const roadNights = f.oneWayTransitNights * (f.roundTrip ? 2 : 1)
  lines.push(`Daily drive limit in effect: ${f.capHours} h.`)
  lines.push(`MINIMUM trip length at that limit: ${f.minNights} night${f.minNights === 1 ? '' : 's'} TOTAL = ${roadNights} night${roadNights === 1 ? '' : 's'} on the road${f.roundTrip ? ' (both directions)' : ''} + 1 night at ${f.destName}. This minimum ALREADY INCLUDES the destination night — never add destination nights on top of it. Any length ≥ ${f.minNights} nights fits; extra nights beyond the minimum are free to spend at destinations.`)
  if (requestedNights != null) {
    if (requestedNights < f.minNights) {
      // Hours per driving day needed to do it in the requested nights: the core
      // drive spread over `requestedNights` driving days (one-way: arrive on the
      // last driving day and sleep there; round trip: both directions).
      const drivingDays = Math.max(1, requestedNights)
      const need = (f.driveHours * (f.roundTrip ? 2 : 1)) / drivingDays
      lines.push(`The user asked for ${requestedNights} night${requestedNights === 1 ? '' : 's'}: that is BELOW the minimum. Doing it in ${requestedNights} would need about ${Math.ceil(need * 2) / 2}-hour drive days instead of ${f.capHours}.`)
    } else {
      const spare = requestedNights - f.minNights
      lines.push(`The user asked for ${requestedNights} night${requestedNights === 1 ? '' : 's'}: that FITS (${roadNights} on the road + ${1 + spare} at destinations). Do not tell the user it needs more nights for the driving.`)
    }
  } else {
    lines.push('Trip length: not stated yet. Ask for it before building.')
  }
  // PLANNER-STOP-SPACING — the planner may not estimate leg hours, so it cannot
  // space stops by itself (it put Tucson 2 h out and left an 11.7 h leg). Name
  // the towns the engine sleeps in on the core drive; the prompt rule makes them
  // the overnight stops unless the user named their own.
  if ((f.roadNightTowns ?? []).length) {
    const towns = f.roadNightTowns.map(t => `${t.name}${t.state ? `, ${t.state}` : ''}`).join(' → ')
    lines.push(`ROAD-NIGHT TOWNS (measured): at the ${f.capHours} h limit the overnights on the core drive land at ${towns}${f.roundTrip ? ' (and the same towns in reverse on the way back)' : ''}. Use these as the on-the-road overnight stops — a neighbouring town on the same highway is fine, but never a stop only an hour or two out that leaves the next leg far over the limit. Extra stops the user asked for go along this same route and each takes a night from the total.`)
  } else if (requestedNights != null || requestedStops != null) {
    lines.push(`No road nights are needed on the core drive at the ${f.capHours} h limit — any stops the user asked for are destinations along the route, each with at least a night.`)
  }
  if (requestedStops != null) {
    const note = requestedNights != null && requestedStops > requestedNights
      ? ` That is MORE than the ${requestedNights} night${requestedNights === 1 ? '' : 's'} asked for — ${requestedStops} stops need at least ${requestedStops} nights.`
      : ''
    lines.push(`The user asked for ${requestedStops} stop${requestedStops === 1 ? '' : 's'}; each stop is at least 1 night. A STOP is a place the trip sleeps: the starting point (${f.originName}) is NEVER a stop, ${f.destName} counts as one of the ${requestedStops}, and so does every road-night town above. Do not ask the user what they mean by a stop.${note}`)
    if (requestedNights != null && requestedNights >= f.minNights) {
      const build = Math.min(requestedNights, requestedStops)
      lines.push(`STOPS TO BUILD: ${build}. ${requestedNights} night${requestedNights === 1 ? '' : 's'} covers up to ${requestedNights} stop${requestedNights === 1 ? '' : 's'}; the user asked for ${requestedStops} → build exactly ${build}: the road-night town${(f.roadNightTowns ?? []).length === 1 ? '' : 's'} above, ${f.destName}, and ${Math.max(0, build - 1 - (f.roadNightTowns ?? []).length)} more destination${Math.max(0, build - 1 - (f.roadNightTowns ?? []).length) === 1 ? '' : 's'} along the same route (1 night each). ${build < requestedStops ? `Say in the build reply that ${requestedStops} stops did not fit in ${requestedNights} nights and you built ${build}.` : 'Never build fewer than this.'}`)
    }
  }
  if (lastOverBudget) {
    lines.push(`Last build attempt: routing via the user's stops made the ${lastOverBudget.legFrom} → ${lastOverBudget.legTo} drive ${lastOverBudget.legHours} h, over the ${f.capHours} h limit, which adds ${lastOverBudget.addedNights} overnight (${lastOverBudget.total} nights total). It was NOT built.`)
  }
  return `<drive_facts>\n${lines.join('\n')}\n</drive_facts>`
}

/** Server-authored hazard advisory prepended to a built plan. Module-level so
 *  the post-model strip below can remove the copy the model sometimes echoes
 *  back from the visible history (it would otherwise print twice). */
const HAZARD_ADVISORY = 'One or more roads on this route may not suit your rig — check the warning pill on the affected stops before you go.'

function buildBudgetConflictAsk(destName: string, minNeeded: number, requestedNights: number): string {
  const need = `${minNeeded} night${minNeeded === 1 ? '' : 's'}`
  const have = `${requestedNights} night${requestedNights === 1 ? '' : 's'}`
  return `This trip to ${destName} needs about ${need} minimum just for the driving — more than the ${have} you set. Want me to bump it to ${need} so it fits, or pick somewhere closer?`
}

export async function chat(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { messages, tripId, sessionId, context, rigId, adHocVehicle, tz } = req.body
    if (!messages || !Array.isArray(messages)) throw new AppError('Messages required', 400)

    // Daily cap for non-paying, non-trial accounts. Quiet cost protection.
    if (await enforceFreeAiCap(req, res)) return
    if (await enforcePerUserDailyCap(req, res)) return

    const userId = req.user!.id

    // Hard cap: cost protection. We never call Claude past this point.
    if (messages.length >= HARD_CAP) {
      console.warn(
        `[AI chat] Hard cap hit on session ${sessionId ?? '(none)'}, ` +
        `context=${context ?? 'planning'}, messages=${messages.length}, userId=${userId}`
      )
      const hardCapMessage = context === 'modify'
        ? HARD_CAP_RESPONSE_MODIFY
        : HARD_CAP_RESPONSE_PLANNING
      return res.json({ message: hardCapMessage, hardCapReached: true })
    }

    // Soft cap: nudge Claude to wrap up by appending an instruction to its system
    // prompt — but DO let it respond, so it can emit the <itinerary> JSON block.
    const softCapHit = messages.length >= SOFT_CAP
    if (softCapHit) {
      console.warn(
        `[AI chat] Soft cap hit on session ${sessionId ?? '(none)'}, ` +
        `messages=${messages.length}, injecting wrap-up nudge`
      )
    }

    // For modify flows, fetch the live trip state from the DB before calling the AI.
    // This is injected as a grounding system message so Claude always sees the actual
    // stop list — even if the user changed the trip outside the chat panel between messages.
    let liveTrip: any = null
    // RIG-CHANGE Phase 3 — all of the user's saved rigs, injected into the modify
    // prompt so the change_rig action can resolve "the Allegro Bus" → a rigId.
    // (The shared userProfile below only carries the DEFAULT rig.) Default first,
    // then oldest, for a stable, readable list.
    let modifyRigs: any[] = []
    if (context === 'modify' && tripId) {
      liveTrip = await prisma.trip.findFirst({
        where: { id: tripId, userId: req.user!.id },
        include: {
          stops: { orderBy: { order: 'asc' } },
          party: { include: { people: true, pets: true } },
          // planningSession is the back-relation from Trip → PlanningSession.
          // Pulling messages here enables the lazy-backfill block below for
          // legacy trips that were promoted before this feature shipped.
          // Tiny payload (the conversation is already small enough to summarize).
          planningSession: { select: { id: true, messages: true } },
        },
      })
      modifyRigs = await prisma.rig.findMany({
        where: { userId: req.user!.id },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })

      // Lazy backfill: trip predates this feature (or its summary call failed
      // at promote time). If we have a linked PlanningSession with messages,
      // generate the summary now, persist it, and inject it into THIS
      // request so the user gets the benefit immediately. Best-effort —
      // failure leaves the field null and the modify chat proceeds without
      // the planning-context block.
      if (liveTrip && !liveTrip.planningContextSummary && liveTrip.planningSession) {
        const sessionMessages = Array.isArray(liveTrip.planningSession.messages)
          ? (liveTrip.planningSession.messages as any[])
          : []
        if (sessionMessages.length > 0) {
          console.log(
            `[AI modify] lazy-backfilling planningContextSummary for tripId=${liveTrip.id} ` +
            `sessionId=${liveTrip.planningSession.id} (${sessionMessages.length} messages)`
          )
          const summary = await generatePlanningContextSummary(sessionMessages, {
            userId: req.user!.id,
            sessionId: liveTrip.planningSession.id,
            tripId: liveTrip.id,
          })
          if (summary) {
            // Mutate the in-memory copy so buildLiveTripState picks it up
            // for THIS request (no need to re-fetch).
            liveTrip.planningContextSummary = summary
            // Persist for future opens — fire-and-forget; if this write
            // fails the next modify open will simply backfill again.
            prisma.trip
              .update({
                where: { id: liveTrip.id },
                data: { planningContextSummary: summary } as any,
              })
              .catch((persistErr) =>
                console.error(
                  `[AI modify] lazy-backfill persist failed for tripId=${liveTrip.id}:`,
                  persistErr?.message ?? persistErr,
                ),
              )
          }
        }
      }
    }

    // AI-MESA-10 — state-aware model-bound annotation. The old blanket
    // annotateAppliedModify stamped EVERY past <modify> block "[✓ change
    // already applied]" regardless of whether the user ever clicked Apply —
    // which (a) lied to the model about unapplied proposals and (b) taught
    // it the marker as normal assistant text it could emit itself (the
    // Cindy/Mesa incident). Now each block is annotated from the verified
    // per-action apply state persisted in modifyConversation: blocks the
    // user applied read "[✓ applied …]", everything else reads "[proposal —
    // NOT applied …]". The original rationale for annotating instead of
    // stripping (keep demonstrating the tag format in-context) still holds.
    const appliedLookup = buildAppliedLookup(liveTrip?.modifyConversation)
    const annotateForModelTurn = (content: string) =>
      annotateForModel(content, action => appliedLookup.has(actionKey(action)))

    // Cap history at the last 10 messages before sending to Claude.
    const HISTORY_CAP = 10
    const nonSystemMessages = messages.filter((m: any) => m.role !== 'system')
    const systemMessages = messages.filter((m: any) => m.role === 'system')
    const cappedMessages = [
      ...systemMessages,
      ...nonSystemMessages.slice(-HISTORY_CAP),
    ]

    // Annotate <modify> tags in assistant history before sending to Claude —
    // state-aware per AI-MESA-10 (see annotateForModelTurn above).
    const cleanedMessages = cappedMessages.map((m: any) =>
      m.role === 'assistant' ? { ...m, content: annotateForModelTurn(m.content) } : m
    )

    const liveStateMsg = liveTrip ? buildLiveTripState(liveTrip, modifyRigs) : null
    if (liveStateMsg) {
      console.log('[AI modify] context=modify tripId=%s stops=%d history=%d',
        tripId, liveTrip.stops?.length ?? 0, nonSystemMessages.length)
      console.log('[AI modify] ground-truth injected:\n', liveStateMsg)
    }
    // The wrap-up nudge is sent as a system message; chatWithAI prepends all
    // system messages to its base system prompt (see services/ai.ts).
    const softCapMsg = softCapHit ? [{ role: 'system' as const, content: SOFT_CAP_NUDGE }] : []
    let messagesForAI = liveStateMsg
      ? [{ role: 'system' as const, content: liveStateMsg }, ...softCapMsg, ...cleanedMessages]
      : [...softCapMsg, ...cleanedMessages]

    const [user] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user!.id },
        include: {
          rigs: { where: { isDefault: true } },
          travelProfile: true,
          memberships: { where: { isActive: true } },
          parties: {
            where: { isDefault: true },
            include: { people: true, pets: true },
            take: 1,
          },
        },
      }),
    ])

    const userProfile = {
      homeCity:     user?.homeCity     || undefined,
      homeState:    user?.homeState    || undefined,
      homeLocation: user?.homeLocation || undefined,
      isFullTimeRVer: user?.isFullTimeRVer ?? false,
      rigs:         user?.rigs,
      travelProfile: user?.travelProfile,
      memberships:  user?.memberships?.map(m => m.type),
      // Phase A: default party plumbed through. Old TravelProfile fields
      // (adults / children / hasPets / petDetails) remain primary until the
      // Phase C cutover; the AI sees both in its JSON context.
      defaultParty: serializeParty(user?.parties?.[0] ?? null),
    }

    // Phase B — plan for the rig the user picked on the planning canvas (passed
    // as rigId), not just their default. The lookup is SCOPED TO THE REQUESTING
    // USER, so a forged/foreign rigId can never load another user's rig — a miss
    // silently keeps the default rig already in userProfile.rigs. An unsaved
    // one-off vehicle rides in via adHocVehicle for prompt context. The rig
    // reaches the model purely through JSON.stringify(userProfile) in the system
    // prompt (services/ai.ts), so swapping userProfile.rigs is the whole fix —
    // every rig-keyed rule (towing, length restrictions, mpg, toy-hauler/OHV,
    // campground fit) then reasons about the selected rig from this message on.
    if (typeof rigId === 'string' && rigId.length > 0) {
      const selectedRig = await prisma.rig.findFirst({
        where: { id: rigId, userId: req.user!.id },
      })
      if (selectedRig) {
        userProfile.rigs = [selectedRig]
        console.log('[AI chat] planning for canvas-selected rig=%s user=%s', selectedRig.id, userId)
      }
    } else if (adHocVehicle && typeof adHocVehicle === 'object') {
      userProfile.rigs = [adHocVehicle]
    }

    // Surprise-trip variety: detect a destination-deferral phrase in the latest
    // user message, then pull the user's last 5 surprise destinations to exclude
    // and pick a random landscape vibe to nudge variety. Falls through silently
    // on any error.
    //
    // These phrases MUST stay in sync with the "Surprise trip rule" in
    // services/ai.ts — the rule fires on "surprise me" / "you pick" / etc., so
    // the detector has to match the same set or the variety machinery (exclusion
    // + vibe) never runs for the cases that actually defer the destination. The
    // earlier detector only matched the literal "surprise trip", which none of
    // the natural phrasings contain → variety system was effectively unreachable.
    const SURPRISE_PHRASES = [
      'surprise trip', 'surprise me', 'you pick', 'you choose',
      'choose somewhere', 'pick a destination', 'pick somewhere', 'pick a place',
    ]
    const matchesSurprise = (text: unknown): boolean =>
      typeof text === 'string' &&
      SURPRISE_PHRASES.some(p => text.toLowerCase().includes(p))

    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')
    const isSurprise = matchesSurprise(lastUserMsg?.content)

    let recentSurpriseDestinations: string[] | undefined
    let surpriseVibe: string | undefined
    if (isSurprise) {
      try {
        // Read from PlanningSession.messages via the trip→planningSession
        // relation. The earlier form filtered on Trip.aiConversation, which
        // was effectively always null in production (the post-promote client
        // write that was supposed to populate it 400'd against the .strict()
        // TripUpdateSchema, and nothing else wrote it for promoted trips).
        // Net effect was a permanently-empty exclusion list, so the AI could
        // re-suggest surprise destinations the user had already been given.
        // PlanningSession.messages is the canonical transcript store and
        // contains the original "surprise trip" user message verbatim.
        const recent = await prisma.trip.findMany({
          where: {
            userId: req.user!.id,
            planningSession: { isNot: null },
          },
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: {
            planningSession: { select: { messages: true } },
            stops: {
              where: { type: 'DESTINATION' },
              orderBy: { order: 'asc' },
              take: 1,
            },
          },
        })
        recentSurpriseDestinations = recent
          .filter(t => matchesSurprise(JSON.stringify(t.planningSession?.messages ?? null)))
          .slice(0, 5)
          .map(t => t.stops[0]?.locationName)
          .filter(Boolean) as string[]
      } catch (err) {
        console.warn('[AI surprise] recent-picks query failed, continuing without exclusion:', err)
      }
      surpriseVibe = VIBES[Math.floor(Math.random() * VIBES.length)]
      console.log('[AI surprise] excluding=%j vibe=%s', recentSurpriseDestinations, surpriseVibe)
    }

    // Prior persisted budget inputs, snapshotted BEFORE this turn's route/tag writes
    // below — the pre-build budget COST GATE compares against these so a settled
    // conversation never re-routes the same leg (no wasted Directions call / latency).
    let priorDestination: string | null = null
    let priorRequestedNights: number | null = null
    // FEAT-TRIP-DRIVE-CAP — the per-trip drive limit in force for this turn's
    // deterministic checks: planning reads it from partialTripData (captured on a
    // prior turn or THIS turn via <drive_cap>), modify reads it off the live trip.
    let tripDriveCap: number | null = null
    // ORIGIN-FIX — read any starting location captured on a PRIOR turn (persisted
    // to PlanningSession.partialTripData after the AI emitted an <origin> tag) and
    // fold it onto userProfile so services/ai.ts can suppress the no-home re-ask
    // directive and tell the model the origin it already has. Planning-only in
    // practice (modify never emits <origin>); guarded on sessionId.
    if (sessionId) {
      const sess = await prisma.planningSession.findUnique({
        where: { id: sessionId },
        select: { partialTripData: true },
      })
      const ptd = (sess?.partialTripData as any) ?? null
      ;(userProfile as any).capturedOrigin = ptd?.origin ?? null
      // Snapshot prior budget inputs for the cost gate (see pre-build check below).
      priorDestination = typeof ptd?.destination === 'string' ? ptd.destination : null
      priorRequestedNights = typeof ptd?.requestedNights === 'number' ? ptd.requestedNights : null
      tripDriveCap = typeof ptd?.driveCapHours === 'number' && ptd.driveCapHours > 0 ? ptd.driveCapHours : null
      // BUILD 3a — surface the confirmed requested trip length (nights) captured
      // on a PRIOR turn (via the <requestedNights> tag below) so the DURATION
      // CONFIRMATION rule in services/ai.ts sees it in the profile context and
      // does NOT re-ask/re-confirm. Capture + confirm only; no reconciler yet.
      ;(userProfile as any).capturedRequestedNights =
        typeof ptd?.requestedNights === 'number' ? ptd.requestedNights : null
      // BUG-AI-NODATE-ASK Part A — surface the confirmed requested START DATE
      // captured on a PRIOR turn (via the <requestedStartDate> tag below) so the
      // DEPARTURE DATE RULE in services/ai.ts sees it and does NOT re-ask. Capture
      // only; the backend date default is unchanged (Part B, separate).
      ;(userProfile as any).capturedRequestedStartDate =
        typeof ptd?.requestedStartDate === 'string' ? ptd.requestedStartDate : null
      // PLANNING-RETENTION (A1) — inject the agreed stop-set as a grounding
      // system message so it survives HISTORY_CAP and re-grounds the model every
      // turn. Planning only (modify mode uses buildLiveTripState/liveStateMsg).
      // This message is DYNAMIC — in services/ai.ts it lands in the uncached
      // suffix, never the cached static prefix (Part B / B3).
      if (context !== 'modify' && Array.isArray(ptd?.agreedStops) && ptd.agreedStops.length > 0) {
        messagesForAI = [
          { role: 'system' as const, content: buildAgreedStopsState(ptd.agreedStops) },
          ...messagesForAI,
        ]
      }
    }

    // ORIGIN-CAPTURE (deterministic) — if no origin is captured yet, scan THIS
    // turn's user message for an explicit "from X to Y" route and capture X as the
    // origin. Setting userProfile.capturedOrigin here (before chatWithAI below)
    // takes effect THIS turn — the gate in services/ai.ts then suppresses the
    // no-home ask, so a user who wrote "from San Jose to Jacksonville" is never
    // asked for an origin they already gave. We do NOT overwrite an existing
    // capturedOrigin (a deliberately-provided origin wins). Persist for future
    // turns best-effort; a write failure must not break the turn. Coexists with
    // the AI's <origin> tag (last-write-wins; different cases).
    // Run the deterministic route parser ONCE; it now yields BOTH origin and dest.
    const detectedRoute = extractFromXtoY(lastUserMsg?.content)

    // ── FEAT-ORIGIN-RESOLVER — ONE authoritative origin resolver ──────────────
    // Fill the origin slot from ALL sources, in priority order, BEFORE the model
    // call so the model AND the hard gate both see it. First non-null wins and is
    // written back to ptd.origin + userProfile.capturedOrigin. Priority:
    //   (a) an already-stored ptd.origin (read into capturedOrigin above) — wins.
    //   (b) FREE-FORM ANSWER — if the PRIOR assistant turn asked for the origin,
    //       treat THIS user message as the answer (ANY phrasing, not just "X to
    //       Y"): "home" → saved home; otherwise geocode-validate it. Accept on a
    //       successful geocode; NEVER store an ungeocodable answer (the safeguard).
    //   (c) the deterministic "X to Y" route form.
    //   (d) the AI <origin> tag — captured post-response (below) for NEXT turn.
    //   (e) saved home — the GATE's fallback, only when genuinely asking.
    let originResolutionFailed = false
    if (!(userProfile as any).capturedOrigin) {
      const priorAssistant = [...messages].reverse().find((m: any) => m.role === 'assistant')
      // A bare number ("2", "10") can never be a place — it is an answer to a
      // nights/stops question even when the prior turn also mentioned the origin.
      const bareNumber = /^\s*\d{1,3}\s*$/.test(String(lastUserMsg?.content ?? ''))
      const answeringOriginAsk = isOriginAsk(priorAssistant?.content) && !!lastUserMsg?.content && !bareNumber
      if (answeringOriginAsk) {
        // (b) free-form answer to the origin question.
        const ans = (lastUserMsg!.content as string).trim()
        const saysHome = /^(?:home|yes+|yep|yeah|sure|from home|my home|starting from home|same as usual|the usual)\b[.!]?$/i.test(ans)
        const homeStr = userProfile.homeCity
          ? `${userProfile.homeCity}${userProfile.homeState ? ', ' + userProfile.homeState : ''}`
          : (userProfile.homeLocation || null)
        if (saysHome && homeStr) {
          ;(userProfile as any).capturedOrigin = homeStr
          if (sessionId) {
            await mergePartialTripData(sessionId, { origin: homeStr })
              .catch((e: any) => console.error('[AI origin-resolver:home-answer] persist failed for sessionId=%s: %s', sessionId, e?.message))
          }
        } else {
          const { resolved, origin } = await geocodeOriginText(stripOriginLeadIn(ans), process.env.GOOGLE_MAPS_API_KEY)
          if (resolved && origin) {
            ;(userProfile as any).capturedOrigin = origin
            if (sessionId) {
              await mergePartialTripData(sessionId, { origin })
                .catch((e: any) => console.error('[AI origin-resolver:free-form] persist failed for sessionId=%s: %s', sessionId, e?.message))
            }
            console.log('[AI origin-resolver] free-form answer geocoded → "%s" sessionId=%s', origin, sessionId ?? '(none)')
          } else {
            // Ungeocodable answer → do NOT store; the gate below asks once more.
            originResolutionFailed = true
            console.warn('[AI origin-resolver] answer "%s" could not be geocoded — asking again. sessionId=%s', ans.slice(0, 60), sessionId ?? '(none)')
          }
        }
      }
      // (c) deterministic "X to Y" route form, only if still unresolved.
      if (!(userProfile as any).capturedOrigin && detectedRoute) {
        ;(userProfile as any).capturedOrigin = detectedRoute.origin
        if (sessionId) {
          await mergePartialTripData(sessionId, { origin: detectedRoute.origin })
            .catch((e: any) => console.error('[AI origin-capture:from-x-to-y] persist failed for sessionId=%s: %s', sessionId, e?.message))
        }
      }
    }
    // DESTINATION (deterministic primary for the pre-build budget check) — persist
    // whenever the route parser found one, so the headline "KC to Bangor" case has a
    // destination WITHOUT depending on the model emitting <destination> that run (the
    // determinism guarantee). Coexists with the AI's <destination> tag (last-write-
    // wins). The downstream cost gate compares prior vs new before any Directions call.
    if (detectedRoute && sessionId) {
      await mergePartialTripData(sessionId, { destination: detectedRoute.dest })
        .catch((e: any) => console.error('[AI dest-capture:from-x-to-y] persist failed for sessionId=%s: %s', sessionId, e?.message))
    }
    // REQUESTED-NIGHTS (deterministic FIRST-capture for the pre-build budget check).
    // The existing <requestedNights> tag + the build-time parseExplicitNights fallback
    // only land a length once the model emits a tag or an <itinerary> — neither is
    // guaranteed on a no-itinerary OPENING turn ("KC to Bangor, 3 nights"). To make
    // the pre-build budget DETERMINISTIC (not a per-run tag gamble), parse an EXPLICIT
    // integer length from THIS turn's message and persist it — but ONLY when none is
    // locked yet (priorRequestedNights null), so a later change still flows through the
    // tag/lock path unchanged. Explicit digits only; fuzzy lengths stay the model's job.
    if (sessionId && priorRequestedNights == null) {
      const earlyNights = parseExplicitNights(lastUserMsg?.content)
      if (earlyNights) {
        await mergePartialTripData(sessionId, { requestedNights: earlyNights })
          .catch((e: any) => console.error('[AI nights-capture:early] persist failed for sessionId=%s: %s', sessionId, e?.message))
      }
    }

    // ── FEAT-PLANNER-FACTS ─────────────────────────────────────────────────────
    // Hand the planner the app's measured facts BEFORE it writes, so it can
    // negotiate length / stops / drive days in its own words with real numbers.
    // Replaces the pre-build canned "needs about N nights minimum" overwrite.
    // Measured once per (origin, destination, shape, cap) and cached on the
    // session (partialTripData.driveFacts) so a settled conversation costs no
    // Directions calls. Fail-soft: any error → no block this turn.
    let driveFacts: DriveFacts | null = null
    let factsRequestedNights: number | null = null
    if (context !== 'modify' && sessionId && process.env.GOOGLE_MAPS_API_KEY) {
      try {
        const s = await prisma.planningSession.findUnique({ where: { id: sessionId }, select: { partialTripData: true } })
        const pb = (s?.partialTripData as any) ?? {}
        const originName: string | null =
          ((userProfile as any).capturedOrigin as string | null) ??
          (userProfile?.homeCity ? `${userProfile.homeCity}${userProfile.homeState ? ', ' + userProfile.homeState : ''}` : null)
        const destination: string | null =
          (typeof pb?.destination === 'string' ? pb.destination : null) ?? detectedRoute?.dest ?? null
        const rn = Number(pb?.requestedNights)
        factsRequestedNights = Number.isInteger(rn) && rn > 0 ? rn : null
        if (originName && destination) {
          const userMsgs = (messages as any[]).filter(m => m?.role === 'user').map(m => String(m?.content ?? ''))
          const roundTrip = hasRoundTripIntent(userMsgs, [originName])
          const capHours = deriveCapHours(user?.travelProfile, tripDriveCap)
          const key = `${originName}|${destination}|${roundTrip ? 'RT' : 'OW'}|${capHours}`
          // Facts cached before PLANNER-STOP-SPACING have no roadNightTowns → recompute once.
          const cached = pb?.driveFacts && pb.driveFacts.key === key && Array.isArray(pb.driveFacts.facts?.roadNightTowns) ? (pb.driveFacts.facts as DriveFacts) : null
          driveFacts = cached ?? await computeDriveFacts(
            originName, destination, roundTrip, capHours, process.env.GOOGLE_MAPS_API_KEY,
            rigDimsFromRig(userProfile.rigs?.[0] as any),
          )
          if (driveFacts && !cached) {
            await mergePartialTripData(sessionId, { driveFacts: { key, facts: driveFacts } }).catch(() => {})
          }
          if (driveFacts) {
            const requestedStops = parseRequestedStops(userMsgs)
            const lastOverBudget = pb?.lastOverBudget ?? null
            const block = buildDriveFactsBlock(driveFacts, factsRequestedNights, requestedStops, lastOverBudget)
            messagesForAI = [{ role: 'system' as const, content: block }, ...messagesForAI]
            console.log('[AI drive-facts] sessionId=%s %s→%s %dmi %sh cap=%dh min=%d requested=%s stops=%s roadNights=[%s] %s',
              sessionId, originName, destination, driveFacts.miles, driveFacts.driveHours, capHours, driveFacts.minNights,
              factsRequestedNights ?? '-', requestedStops ?? '-',
              (driveFacts.roadNightTowns ?? []).map(t => `${t.name}, ${t.state}`).join(' → ') || 'none',
              cached ? '(cached)' : '(measured)')
          }
        }
      } catch (e: any) {
        console.warn('[AI drive-facts] skipped: %s', e?.message ?? e)
      }
    }

    // BUG-THIS-FRIDAY — the client's IANA timezone feeds the CALENDAR block.
    const aiCtx = { userId, sessionId: sessionId ?? null, tripId: tripId ?? null, tz: typeof tz === 'string' && tz.length <= 64 ? tz : null }
    // SCOPE-GUARD-2 — opening turn of a NEW planning session: not modify, and no
    // assistant reply exists yet in the history. Biases the scope-guard toward
    // trip-intent so a terse opener ("[Place] and back") is planned, not refused.
    const isOpeningTurn = context !== 'modify' && !messages.some((m: any) => m.role === 'assistant')
    let response = await chatWithAI(messagesForAI, userProfile, recentSurpriseDestinations, surpriseVibe, aiCtx, isOpeningTurn, context === 'modify')
    // The model echoes server-authored advisories it saw in earlier replies;
    // strip them here — the server re-adds its own when a hazard fires this turn.
    if (context !== 'modify' && response.includes(HAZARD_ADVISORY)) {
      response = response.split(HAZARD_ADVISORY).join('').replace(/\n{3,}/g, '\n\n').trim()
    }

    // Three-state modify-mode outcome, surfaced to the client in the response
    // envelope. 'proposal' = actionable change (<modify> tag); 'clarify' = the
    // model intentionally asked the user for more info (<clarify> tag, NOT an
    // error); 'failed' = neither tag after a retry (a genuine no-op the UI
    // warns about). null for non-modify chats. This replaces the old binary
    // modifyTagMissing, which conflated clarify questions with failures.
    let modifyOutcome: 'proposal' | 'clarify' | 'failed' | null = null
    // AI-MESA-10 — server-parsed <modify> actions for this turn (modify mode
    // only). Returned in the envelope and persisted with applied=false.
    let parsedActions: ReturnType<typeof parseModifyBlocks> = []

    if (liveStateMsg) {
      const hasModify = /<modify>/.test(response)
      // FEAT-TRIP-DRIVE-CAP — a stated drive limit is a valid, self-declared
      // outcome with no <modify> block (the app applies it, not the model).
      // Counting it as a clarify-class reply keeps the auto-retry from firing
      // and REPLACING the reply that carried the tag.
      const hasDriveCap = /<drive_cap>/.test(response) || /<pet>/.test(response)
      const hasClarify = /<clarify>/.test(response) || hasDriveCap
      console.log('[AI modify] response hasModify=%s hasClarify=%s hasDriveCap=%s preview=%s', hasModify, hasClarify, hasDriveCap, response.slice(0, 200))

      // Auto-retry ONLY when the model emitted NEITHER tag — then we can't tell
      // whether it meant to propose a change or to ask a question. A reply that
      // already carries <modify> (proposal) or <clarify> (intentional question)
      // is a valid, self-declared outcome and needs no retry. One retry only;
      // the reminder pushes the model to commit to exactly one tag.
      if (!hasModify && !hasClarify) {
        console.warn('[AI modify] No <modify>/<clarify> tag detected in modification response — auto-retrying with reminder')
        const retryMessages = [
          ...messagesForAI,
          { role: 'assistant' as const, content: annotateForModelTurn(response) },
          {
            role: 'user' as const,
            content:
              '[SYSTEM REMINDER: Your previous reply included neither a <modify> nor a <clarify> tag, so NO change was applied and the UI cannot tell what you intended. ' +
              'If the user\'s request requires trip modifications, repeat your response and include the correct <modify>{...}</modify> block(s) now — one block per change, in execution order. ' +
              'If you instead need more information from the user before you can propose a change (a question or discussion turn), wrap your reply in a <clarify>...</clarify> tag. ' +
              'Emit one-or-more <modify> blocks OR exactly one <clarify> — never neither.]',
          },
        ]
        const retryResponse = await chatWithAI(retryMessages, userProfile, recentSurpriseDestinations, surpriseVibe, aiCtx, isOpeningTurn, context === 'modify')
        const retryHasModify = /<modify>/.test(retryResponse)
        const retryHasClarify = /<clarify>/.test(retryResponse)
        console.log('[AI modify] retry hasModify=%s hasClarify=%s preview=%s', retryHasModify, retryHasClarify, retryResponse.slice(0, 200))
        if (retryHasModify || retryHasClarify) {
          response = retryResponse
        }
        // else: retry also produced neither tag — keep the original response;
        // the classification below resolves it to 'failed'.
      }

      // Classify the FINAL response into one of the three outcomes.
      if (/<modify>/.test(response)) modifyOutcome = 'proposal'
      else if (/<clarify>/.test(response) || /<drive_cap>/.test(response) || /<pet>/.test(response)) modifyOutcome = 'clarify'
      else modifyOutcome = 'failed'

      // Unwrap any <clarify>…</clarify> so the user sees only the question
      // text, never the raw tag (mirrors how the client strips <modify> from
      // displayed prose). Done before persistence so reloaded history is clean.
      response = response.replace(/<clarify>([\s\S]*?)<\/clarify>/g, '$1').trim()

      // AI-MESA-10 — server is the single parse authority: extract EVERY
      // <modify> block into structured actions (stable ids, applied=false).
      // The raw tags stay in `response` so the not-yet-updated client's
      // first-block parser keeps working through the phase gap; the Phase 2
      // client drives entirely off actions[].
      parsedActions = parseModifyBlocks(response)

      // If the tags exist but none parsed (malformed JSON in every block),
      // 'proposal' would promise the client an applyable change that doesn't
      // exist — downgrade to 'failed' so the UI warns instead.
      if (modifyOutcome === 'proposal' && parsedActions.length === 0) {
        console.warn('[AI modify] <modify> tags present but no block parsed — downgrading outcome to failed')
        modifyOutcome = 'failed'
      }

      // AI-MESA-10 deterministic display guard: the model must never be able
      // to assert an apply. Strips "[✓ change already applied]" and close
      // bracketed variants from the displayed/persisted text. <modify> tags
      // are untouched.
      response = stripAppliedClaims(response)
    }

    // ── FEAT-AI-TAG-PRIMARY — the AI's structured tags are the PRIMARY origin/
    // destination source. The model understands messy/glued/typo'd/voice input that
    // the deterministic extractFromXtoY regex (now the pre-model FALLBACK) misses,
    // and emits <origin>/<destination> in THIS reply. Capture them HERE — BEFORE the
    // origin gate below — so a turn-1 tagged origin sets capturedOrigin and the gate
    // is suppressed in the SAME turn. Each tag is GEOCODE-VALIDATED (a mis-tag can't
    // store garbage). The ORIGIN tag additionally requires its city's first token to
    // appear as a token in the user's OWN messages (anti-fabrication — preserves the
    // MESA no-home protection: origin must be user-grounded, never invented). The
    // DESTINATION tag is geocode-validated but NOT user-gated, because the AI
    // legitimately CHOOSES the destination on surprise / "pick somewhere" trips.
    // Tags are stripped from the reply here (so the old post-gate handlers are gone).
    if (context !== 'modify') {
      const normTok = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      const userTokens = new Set(
        messages
          .filter((m: any) => m.role === 'user')
          .flatMap((m: any) => normTok(m.content).split(' '))
          .filter(Boolean),
      )

      // ORIGIN tag → PRIMARY capture. Only when not already resolved pre-model
      // (stored ptd.origin / free-form answer / regex). Geocode + user-grounded.
      const oTag = response.match(/<origin>([\s\S]*?)<\/origin>/)
      if (oTag) {
        response = response.replace(/<origin>[\s\S]*?<\/origin>/g, '').trim()
        const tagged = oTag[1].trim()
        if (tagged && !(userProfile as any).capturedOrigin) {
          const cityFirstTok = normTok(tagged.split(',')[0]).split(' ').filter(Boolean)[0] ?? ''
          // BUG-ORIGIN-STREET-ADDRESS (2026-09-05): "trip to Del Rio Texas to 504
          // Edna St." → the model tagged <origin>504 Edna St</origin>, "504" passed
          // the user-token gate, and Google geocoded the bare street to Greater
          // Sudbury, ON. Two deterministic rejections: (a) a bare street address
          // (starts with a number, names no city) can never be an origin; (b) text
          // the user wrote right after "to" is destination phrasing.
          const userText = messages.filter((m: any) => m.role === 'user').map((m: any) => normTok(m.content)).join(' ')
          const bareStreet = /^\d+\s+\S+/.test(tagged) && !tagged.includes(',')
          const afterTo = new RegExp(`\\bto\\s+${normTok(tagged).split(' ').slice(0, 2).join('\\s+')}`).test(userText)
          if (bareStreet || afterTo) {
            console.warn('[AI origin-guard] AI <origin> "%s" rejected — %s. sessionId=%s', tagged, bareStreet ? 'bare street address' : 'destination phrasing ("to …")', sessionId ?? '(none)')
          } else if (cityFirstTok && userTokens.has(cityFirstTok)) {
            const { resolved, origin } = await geocodeOriginText(tagged, process.env.GOOGLE_MAPS_API_KEY)
            if (resolved && origin) {
              ;(userProfile as any).capturedOrigin = origin
              if (sessionId) {
                await mergePartialTripData(sessionId, { origin })
                  .catch((e: any) => console.error('[AI origin-capture:ai-tag] persist failed for sessionId=%s: %s', sessionId, e?.message))
              }
              console.log('[AI origin-resolver] AI <origin> "%s" → "%s" (user-grounded + geocoded) sessionId=%s', tagged, origin, sessionId ?? '(none)')
            } else {
              console.warn('[AI origin-resolver] AI <origin> "%s" did not geocode — ignored. sessionId=%s', tagged, sessionId ?? '(none)')
            }
          } else {
            console.warn('[AI origin-guard] AI <origin> "%s" not present in any user message — treating as fabricated, ignored. sessionId=%s', tagged, sessionId ?? '(none)')
          }
        }
      }

      // DESTINATION tag → PRIMARY capture (geocode-validated; AI may choose it on
      // surprise trips, so NO user-mention gate). Stores the model's exact wording
      // when it validates, for the pre-build budget check (minimalTripBudget).
      const dTag = response.match(/<destination>([\s\S]*?)<\/destination>/)
      if (dTag) {
        response = response.replace(/<destination>[\s\S]*?<\/destination>/g, '').trim()
        const taggedDest = dTag[1].trim()
        if (taggedDest && sessionId) {
          const { resolved } = await geocodeOriginText(taggedDest, process.env.GOOGLE_MAPS_API_KEY)
          if (resolved) {
            await mergePartialTripData(sessionId, { destination: taggedDest })
              .catch((e: any) => console.error('[AI destination-capture:ai-tag] persist failed for sessionId=%s: %s', sessionId, e?.message))
          } else {
            console.warn('[AI destination-capture] AI <destination> "%s" did not geocode — not persisted. sessionId=%s', taggedDest, sessionId ?? '(none)')
          }
        }
      }
    }

    // AI-MESA-7 — DETERMINISTIC ORIGIN GUARD (no-home users, planning mode only).
    // Prompt-level fixes (AI-MESA-4/5/6) cannot reliably stop the model fabricating
    // an origin to satisfy the mandatory order-1 HOME stop (7 runs → 6 fabricated).
    // This server-side guard does not depend on model compliance: if a no-home user
    // gets an itinerary whose HOME city was NEVER typed by them, that origin was
    // invented, so we discard the whole itinerary and return a canned "where will you
    // be starting from?" reply instead. The replaced response has no <itinerary>, so
    // the client shows no Build button and the trip cannot build until a real origin
    // is given. Fail-safe: a phrasing mismatch only costs the user one extra question.
    //
    // Fires ONLY when ALL hold:
    //   - context !== 'modify'  (never touch modify-mode, which edits an existing trip)
    //   - hasHomeOnFile === false  (home-on-file users keep their existing behavior)
    //   - NO resolved trip origin yet (FEAT-ORIGIN-RESOLVER hard gate): once
    //     capturedOrigin is set — from ANY source: a free-form answer, "X to Y", a
    //     prior <origin> capture, or a "home" answer — the origin question is
    //     STRUCTURALLY unreachable. The controller never emits NO_ORIGIN_RESPONSE
    //     and never runs the MESA-7/9 fabrication-replace below, so a known origin
    //     can never be re-asked, and a no-home user with a captured origin is never
    //     asked merely because home is unsaved.
    //   - response contains a parseable <itinerary> whose stops[0].type === 'HOME'
    //   - the HOME city appears in NONE of the user's own messages
    const hasHomeOnFile = !!(userProfile.homeCity || userProfile.homeLocation)
    if (context !== 'modify' && !hasHomeOnFile && !(userProfile as any).capturedOrigin) {
      const itin = parseItineraryBlock(response)
      const homeStop = itin?.stops?.[0]
      if (itin && homeStop?.type === 'HOME') {
        const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
        const cityNorm = norm(homeStop.locationName)
        const userText = messages
          .filter((m: any) => m.role === 'user')
          .map((m: any) => norm(m.content))
          .join(' ')
        // Primary signal: did the user ever type this city?
        let userProvidedOrigin = cityNorm.length > 0 && userText.includes(cityNorm)
        // Robustness against phrasing mismatch (conservative — only WIDENS what counts
        // as user-provided, so it can only REDUCE false positives, never cause a
        // fabricated city to slip through):
        //  - the user typed the verbatim startAddress the model copied into the HOME stop, OR
        //  - the user typed BOTH the city AND its state (state alone is never enough).
        if (!userProvidedOrigin) {
          const addrNorm = norm(homeStop.startAddress)
          if (addrNorm.length > 0 && userText.includes(addrNorm)) {
            userProvidedOrigin = true
          }
        }
        if (!userProvidedOrigin) {
          const stateNorm = norm(homeStop.locationState)
          if (cityNorm.length > 0 && stateNorm.length > 0 &&
              userText.includes(cityNorm) && userText.includes(stateNorm)) {
            userProvidedOrigin = true
          }
        }
        if (!userProvidedOrigin) {
          console.warn(
            '[AI origin-guard] no-home user, fabricated HOME city "%s" (state "%s") not present in any user message — blocking itinerary, asking for origin. userId=%s sessionId=%s',
            homeStop.locationName, homeStop.locationState ?? '', userId, sessionId ?? '(none)',
          )
          // Discard the fabricated itinerary; persist + return the canned ask instead.
          response = NO_ORIGIN_RESPONSE
        }
      }

      // AI-MESA-9 — PROSE ORIGIN-ASSERTION GUARD (sibling to the itinerary check
      // above). The AI-MESA-7 block only inspects the <itinerary> JSON, so a
      // fabricated origin stated only in PRE-ITINERARY PROSE — e.g. the scripted
      // "Got it — starting from <City>" / "I'll use your home address in <City>"
      // confirmation lines — slipped through (Pittsburgh→Columbus; "home address
      // in Phoenix"). This runs only when the turn was not already blocked, and
      // computes its own norm/userText so the AI-MESA-7 block above is untouched.
      if (response !== NO_ORIGIN_RESPONSE) {
        const asserted = extractAssertedOrigin(response)
        if (asserted) {
          const normP = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
          const userTextP = messages
            .filter((m: any) => m.role === 'user')
            .map((m: any) => normP(m.content))
            .join(' ')
          const firstTok = normP(asserted).split(' ')[0]
          // Block only when the asserted origin's city token appears in NONE of the
          // user's own messages — the model named a starting city the user never
          // provided. Fail-safe: a phrasing mismatch only costs one extra ask.
          if (firstTok.length > 0 && !userTextP.includes(firstTok)) {
            console.warn(
              '[AI origin-guard] no-home user, assistant prose asserts origin "%s" not present in any user message — replacing with origin ask. userId=%s sessionId=%s',
              asserted, userId, sessionId ?? '(none)',
            )
            response = NO_ORIGIN_RESPONSE
          }
        }
      }

    }

    // FEAT-ORIGIN-RESOLVER safeguard — the user ANSWERED the origin question but the
    // answer could not be geocoded (resolveTripOrigin set originResolutionFailed and
    // stored nothing). Replace the reply with a deterministic acknowledging re-ask
    // so we never loop on a settled-but-unplaceable answer and never store garbage.
    // Wins over the model's own output (which may be a fabricated itinerary).
    if (context !== 'modify' && originResolutionFailed && !(userProfile as any).capturedOrigin) {
      response = NO_ORIGIN_RETRY_RESPONSE
    }

    // INVERTED ORIGIN GUARD — origin is KNOWN but the model re-asked anyway. Runs
    // for ALL planning users (home-on-file INCLUDED): a home-on-file user's
    // confirmed/defaulted-home origin now persists via <origin> too (the :247
    // carve-out was removed), so the same deterministic backstop applies —
    // capturedOrigin is set yet the reply still emits an origin/home re-ask
    // (stochastic non-compliance), so we force ONE re-call with an "already known,
    // proceed now" reminder and the user never sees the redundant re-ask. Inert
    // when capturedOrigin is null (a legitimate FIRST origin ask passes through
    // untouched). The MESA-7/9 no-home guards above don't overlap: they fire on a
    // fabricated/un-typed origin, whereas capturedOrigin is a real captured city
    // or the user's saved home.
    if (context !== 'modify') {
      const capturedOrigin = (userProfile as any).capturedOrigin as string | null
      if (capturedOrigin && isOriginAsk(response)) {
        console.warn(
          '[AI origin-guard] origin "%s" already known but model re-asked — forcing proceed. sessionId=%s',
          capturedOrigin, sessionId ?? '(none)',
        )
        const retryMessages = [
          ...messagesForAI,
          { role: 'assistant' as const, content: response },
          {
            role: 'user' as const,
            content: `[SYSTEM REMINDER: The starting location is ALREADY KNOWN: ${capturedOrigin}. Do NOT ask about the origin and do NOT offer a "home" option. Proceed NOW and plan the requested trip, emitting the <itinerary> block.]`,
          },
        ]
        const retry = await chatWithAI(retryMessages, userProfile, recentSurpriseDestinations, surpriseVibe, aiCtx)
        if (!isOriginAsk(retry)) response = retry
      }
    }

    // ORIGIN / DESTINATION tag capture moved EARLIER (FEAT-AI-TAG-PRIMARY, right
    // after the model call, before the origin gate) so a turn-1 tagged origin
    // suppresses the gate in the same turn and both tags are geocode-validated.
    // The tags are already extracted + stripped there, so no handler is needed here.

    // RIG-CAPTURE (FR-RIG-MISMATCH, Approach B) — capture the AI's structured <rig>
    // tag, emitted only when the user states THEIR OWN current rig in chat (the model
    // applies the friend's-rig / hypothetical / shopping exclusions). Strip it from
    // the displayed message (mirrors <origin>), validate against the 9 VehicleType
    // enum values, and persist to partialTripData.statedRig for a later mismatch
    // banner (Phase 2). ADVISORY METADATA ONLY — statedRig never feeds any calc/fuel/
    // planner-rig path; trip math still runs off the profile rig. Merge so origin and
    // agreedStops are never clobbered.
    const rigMatch = response.match(/<rig>([\s\S]*?)<\/rig>/)
    if (rigMatch) {
      response = response.replace(/<rig>[\s\S]*?<\/rig>/g, '').trim()
      const rawRig = rigMatch[1].trim().toUpperCase()
      if (sessionId && (VEHICLE_TYPES as readonly string[]).includes(rawRig)) {
        try {
          await mergePartialTripData(sessionId, { statedRig: rawRig })
        } catch (e: any) {
          console.error('[AI rig-capture] persist failed for sessionId=%s: %s', sessionId, e?.message)
        }
      } else if (rawRig) {
        console.warn('[AI rig-capture] ignored non-enum <rig> value "%s" sessionId=%s', rawRig, sessionId ?? '(none)')
      }
    }

    // REQUESTED-NIGHTS CAPTURE (BUILD 3a) — capture the AI's structured
    // <requestedNights> tag, emitted only on the turn the user CONFIRMS the trip
    // length (per the DURATION CONFIRMATION rule). Strip it from the displayed
    // message (mirrors <origin>/<rig>), validate it is a positive integer, and
    // persist to partialTripData.requestedNights for the later (Build 3b)
    // reconciler. Capture + confirm ONLY — this number does not yet pad/trim any
    // trip. Merge so origin / agreedStops / statedRig are never clobbered.
    const reqNightsMatch = response.match(/<requestedNights>([\s\S]*?)<\/requestedNights>/)
    if (reqNightsMatch) {
      response = response.replace(/<requestedNights>[\s\S]*?<\/requestedNights>/g, '').trim()
      const rawNights = reqNightsMatch[1].trim()
      const parsedNights = Number(rawNights)
      if (sessionId && Number.isInteger(parsedNights) && parsedNights > 0) {
        try {
          await mergePartialTripData(sessionId, { requestedNights: parsedNights })
        } catch (e: any) {
          console.error('[AI requested-nights-capture] persist failed for sessionId=%s: %s', sessionId, e?.message)
        }
      } else if (rawNights) {
        console.warn('[AI requested-nights-capture] ignored non-positive-integer <requestedNights> value "%s" sessionId=%s', rawNights, sessionId ?? '(none)')
      }
    }

    // DRIVE-CAP CAPTURE (FEAT-TRIP-DRIVE-CAP) — the user stated a daily drive
    // limit for this trip ("keep drive days under 4 hours"). The model emits
    // <drive_cap>4</drive_cap>; strip it, validate 1–16h, and persist:
    //   planning → partialTripData.driveCapHours (copied to Trip.maxDriveHours at
    //              promote), and it governs THIS turn's planning-time transit check;
    //   modify   → Trip.maxDriveHours directly, then the long-leg recheck re-runs
    //              so the trip reshapes to the new limit without a second ask.
    const driveCapMatch = response.match(/<drive_cap>([\s\S]*?)<\/drive_cap>/)
    if (driveCapMatch) {
      response = response.replace(/<drive_cap>[\s\S]*?<\/drive_cap>/g, '').trim()
      const rawCap = driveCapMatch[1].trim()
      const parsedCap = Number(rawCap)
      // CAP-CONSENT (2026-09-05): the planner emitted <drive_cap>8.5 in the very
      // reply that ASKED "are you good with 8.5-hour days?", and the trip kept
      // the raised cap after the user said "ok 3" instead. A RAISE above the cap
      // in effect is only honoured when the reply is not still asking — a reply
      // that ends in a question is a proposal, not consent. Lowering (the user
      // stating a tighter limit) is always honoured.
      const capInEffect = deriveCapHours(user?.travelProfile, tripDriveCap)
      const stillAsking = /\?\s*$/.test(response.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim())
      if (Number.isFinite(parsedCap) && parsedCap > capInEffect && stillAsking) {
        console.log('[AI drive-cap] deferred raise to %sh — reply is still asking (cap in effect %sh)', parsedCap, capInEffect)
      } else if (Number.isFinite(parsedCap) && parsedCap >= 1 && parsedCap <= 16) {
        tripDriveCap = parsedCap
        if (context === 'modify' && tripId && liveTrip) {
          try {
            await prisma.trip.update({ where: { id: tripId }, data: { maxDriveHours: parsedCap } })
            console.log('[AI drive-cap] tripId=%s maxDriveHours=%s (modify)', tripId, parsedCap)
            // strict: re-measure every consecutive pair (overnight-only stops
            // included) so a tightened cap reshapes legs the normal, idempotent
            // recheck would treat as already answered.
            const { note } = await recheckLongLegs(tripId, req.user!.id, { strict: true })
            if (note) response = `${response}\n\n${note}`.trim()
          } catch (e: any) {
            console.error('[AI drive-cap] modify persist/recheck failed tripId=%s: %s', tripId, e?.message)
          }
        } else if (sessionId) {
          try {
            await mergePartialTripData(sessionId, { driveCapHours: parsedCap })
            console.log('[AI drive-cap] sessionId=%s driveCapHours=%s (planning)', sessionId, parsedCap)
          } catch (e: any) {
            console.error('[AI drive-cap] planning persist failed for sessionId=%s: %s', sessionId, e?.message)
          }
        }
      } else if (rawCap) {
        console.warn('[AI drive-cap] ignored out-of-range <drive_cap> value "%s"', rawCap)
      }
    }

    // PET CAPTURE (FEAT-PET-CAPTURE) — the user said THEIR pet is coming
    // ("we're bringing Callie, our golden"). The model emits one
    // <pet>TYPE|Name|Breed</pet> per pet; strip them, persist to the default
    // party (and the trip's party in modify mode), dedup by name. The packing
    // and planning prompts already read party.pets — this is what fills it.
    const petTags = [...response.matchAll(/<pet>([\s\S]*?)<\/pet>/g)]
    if (petTags.length) {
      response = response.replace(/<pet>[\s\S]*?<\/pet>/g, '').trim()
      const pets = petTags.map(m => parsePetTag(m[1])).filter((p): p is NonNullable<typeof p> => !!p)
      if (pets.length) {
        const created = await persistCapturedPets(
          req.user!.id,
          context === 'modify' && tripId ? tripId : null,
          pets,
        )
        console.log('[pet-capture] %d tag(s) → %d pet row(s) created (context=%s)', pets.length, created, context)
      }
    }

    // REQUESTED-NIGHTS SINGLE-SHOT FALLBACK — under the state-and-proceed opening
    // flow a one-shot prompt ("…6 days…") can state the length AND emit the
    // <itinerary> in the SAME turn; if the model didn't append <requestedNights>
    // on that turn, the target would never persist. It still backs the deterministic
    // build gate's LENGTH signal (capturedRequestedNights), so capture it here too:
    // when THIS turn builds an itinerary, no valid tag was captured above, and no
    // target is already locked, deterministically parse an EXPLICIT integer duration
    // from the user's latest message and persist it. Conservative — explicit digits
    // only; fuzzy lengths stay the model's job via the tag. (The old nights
    // reconciler that also consumed this was retired in Part 2 — transit nights are
    // now real nights the user sees and approves.)
    const tagCaptured = !!reqNightsMatch
    const alreadyLocked =
      Number.isInteger((userProfile as any).capturedRequestedNights) &&
      (userProfile as any).capturedRequestedNights > 0
    if (sessionId && !tagCaptured && !alreadyLocked && /<itinerary>/.test(response)) {
      const fallbackNights = parseExplicitNights(lastUserMsg?.content)
      if (fallbackNights) {
        try {
          await mergePartialTripData(sessionId, { requestedNights: fallbackNights })
          console.log('[AI requested-nights-fallback] captured %d nights from user text (no tag) sessionId=%s', fallbackNights, sessionId)
        } catch (e: any) {
          console.error('[AI requested-nights-fallback] persist failed for sessionId=%s: %s', sessionId, e?.message)
        }
      }
    }

    // REQUESTED-START-DATE CAPTURE (BUG-AI-NODATE-ASK Part A) — capture the AI's
    // <requestedStartDate> tag, emitted once the trip start date is settled.
    // Strip it from the displayed message (mirrors <requestedNights>/<rig>),
    // validate it is a real ISO yyyy-mm-dd, and persist to
    // partialTripData.requestedStartDate so the DEPARTURE DATE RULE won't re-ask.
    // Capture ONLY — does NOT change the backend date default (Part B, separate).
    // Merge so origin / agreedStops / statedRig / requestedNights are never clobbered.
    const reqStartMatch = response.match(/<requestedStartDate>([\s\S]*?)<\/requestedStartDate>/)
    if (reqStartMatch) {
      response = response.replace(/<requestedStartDate>[\s\S]*?<\/requestedStartDate>/g, '').trim()
      const rawDate = reqStartMatch[1].trim()
      // Real-calendar-date guard: the round-trip through Date rejects malformed
      // or out-of-range values (e.g. 2026-13-40) that pass the shape regex.
      const isShaped = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      const isReal = isShaped && new Date(`${rawDate}T00:00:00Z`).toISOString().slice(0, 10) === rawDate
      if (sessionId && isReal) {
        try {
          await mergePartialTripData(sessionId, { requestedStartDate: rawDate })
        } catch (e: any) {
          console.error('[AI requested-start-date-capture] persist failed for sessionId=%s: %s', sessionId, e?.message)
        }
      } else if (rawDate) {
        console.warn('[AI requested-start-date-capture] ignored invalid <requestedStartDate> value "%s" sessionId=%s', rawDate, sessionId ?? '(none)')
      }
    }

    // FR-BUILD-GATE — DETERMINISTIC WHERE/WHEN/LENGTH BUILD GATE. Sibling to the
    // AI-MESA-7 origin guard: the planner must NOT build until all three
    // essentials are present. Prompt-only gating proved insufficient (the nights
    // regression), so this is the guarantee — if the model emits an <itinerary>
    // in planning mode that lacks a real destination, a pinned start date, or a
    // length, we DISCARD the itinerary and replace the reply with a targeted ask
    // (no <itinerary> → no Build button → cannot promote). Runs for ALL planning
    // users (unlike the origin guard's no-home scope) and BEFORE the
    // planning-retention snapshot so an incomplete build is never snapshotted.
    //
    // Composition with the origin guard: if that guard already stripped the
    // itinerary (response = NO_ORIGIN_RESPONSE), parseItineraryBlock returns null
    // here and this gate no-ops — the user sees ONE coherent ask, never two.
    //
    // Anti-re-ask (do NOT reintroduce the 6bad5e1 regression): the gate reads the
    // FRESH persisted captures (this turn's <requestedNights>/<requestedStartDate>
    // were merged just above) plus the itinerary's own startDate, so it never
    // re-asks for a date/length the user gave on a PRIOR turn. WHEN keys on a real
    // startDate (the stated-assumption / first-Tuesday path sets one, so it
    // passes) — only a truly null/un-pinned date is blocked.
    if (context !== 'modify') {
      const gateItin = parseItineraryBlock(response)
      const gateStops = Array.isArray(gateItin?.stops) ? (gateItin!.stops as any[]) : null
      if (gateItin && gateStops && gateStops.length > 0) {
        // Freshest persisted captures (include this turn's tags merged above).
        let gatePtd: any = null
        if (sessionId) {
          try {
            const s = await prisma.planningSession.findUnique({
              where: { id: sessionId },
              select: { partialTripData: true },
            })
            gatePtd = (s?.partialTripData as any) ?? null
          } catch { /* fall back to itinerary-only signals */ }
        }

        const isIsoDate = (v: unknown) =>
          typeof v === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(v) &&
          new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

        // WHEN — primary signal: the itinerary's own startDate is a real ISO date.
        // Passes both a user-typed date AND the stated-assumption path (both set
        // startDate); a captured requestedStartDate also counts. Only a truly
        // null/un-pinned date blocks.
        const whenOk = isIsoDate(gateItin.startDate) || isIsoDate(gatePtd?.requestedStartDate)

        // LENGTH — the USER must have given a length: the captured target (the
        // model's <requestedNights> tag or the explicit-digits fallback above), or
        // an explicit "N nights / N days" in any user message. LENGTH-GATE
        // (2026-09-05): the old fallback accepted the itinerary's own summed
        // nights — always > 0 once the model invents them — so a "four stop trip
        // to Del Rio this Friday" got a made-up 4-night plan on turn 1 with no
        // question asked. Fuzzy lengths ("a weekend", "about a week") still reach
        // the gate through the model's tag, which is emitted on those turns.
        const capturedNights = Number(gatePtd?.requestedNights)
        const msgArr = messages as any[]
        let userStatedNights: number | null = null
        for (let i = 0; i < msgArr.length; i++) {
          const m = msgArr[i]
          if (m?.role !== 'user') continue
          const text = String(m?.content ?? '')
          const explicit = parseExplicitNights(text)
          if (explicit != null) { userStatedNights = explicit; break }
          // A bare number answering a nights question ("how many nights?" → "2")
          // is a stated length too — don't loop the user through the ask again.
          const prev = msgArr[i - 1]
          const bare = text.trim().match(/^(\d{1,2})$/)
          if (bare && prev?.role === 'assistant' && /night/i.test(String(prev?.content ?? ''))) { userStatedNights = Number(bare[1]); break }
        }
        const lengthOk = (Number.isInteger(capturedNights) && capturedNights > 0) || userStatedNights != null

        // WHERE — at least one real DESTINATION stop away from the origin/home
        // city (a lone HOME stop, or only a same-city return closer, doesn't count).
        const normCity = (s: unknown) => String(s ?? '').toLowerCase().trim()
        const homeCityNorm = normCity(gateStops[0]?.locationName)
        const whereOk = gateStops.some(
          s => s?.type === 'DESTINATION' && normCity(s?.locationName) !== homeCityNorm,
        )

        if (!whereOk || !whenOk || !lengthOk) {
          const missing = [
            !whereOk ? 'where' : null,
            !whenOk ? 'when' : null,
            !lengthOk ? 'length' : null,
          ].filter(Boolean).join('+')
          console.warn(
            '[AI build-gate] blocking itinerary — missing %s (whereOk=%s whenOk=%s lengthOk=%s) userId=%s sessionId=%s',
            missing, whereOk, whenOk, lengthOk, userId, sessionId ?? '(none)',
          )
          response = buildGateAsk(whereOk, whenOk, lengthOk)
        }
      }
    }

    // PLAN-IS-TRUTH (Part 2, step 2) — DETERMINISTIC DRIVE-TIME CHECK AT PLANNING
    // TIME. The planner only ESTIMATES drive times (~55 mph), so it under-inserts
    // transit stops; build no longer fixes this (Part 1 removed expandLongLegs from
    // the build chain). Run the SAME deterministic check here, on the AI's
    // city-name itinerary, so any needed OVERNIGHT_ONLY transit stop lands in the
    // panel the user APPROVES — and build stays a verbatim copy.
    //
    // Idempotent by construction (planTransitInserts skips any real→real segment
    // that already carries an overnight): re-emitting an unchanged itinerary never
    // re-splits or double-inserts. The inserted stop survives turn-to-turn via the
    // existing agreedStops snapshot below (it captures stop type), so the next turn
    // re-grounds the model with it — NO new memory.
    //
    // Splice BEFORE the planning-retention/nightsShortfall block so both read the
    // corrected itinerary. Planning only; fail-soft — a Directions error (or any
    // throw) leaves the itinerary as the AI emitted it and never blocks the reply.
    if (context !== 'modify' && process.env.GOOGLE_MAPS_API_KEY) {
      try {
        const transitItin = parseItineraryBlock(response)
        const transitStops = Array.isArray(transitItin?.stops) ? (transitItin!.stops as any[]) : null
        if (transitItin && transitStops && transitStops.length >= 2) {
          const capHours = deriveCapHours(user?.travelProfile, tripDriveCap)
          // FEAT-HERE-ROUTING — rig dims for the truck-routing measurement, taken
          // from the rig the user is planning FOR (canvas-selected / default /
          // ad-hoc, already resolved into userProfile.rigs above). Only consumed
          // when USE_HERE_ROUTING is on; on the Google path it's ignored, so the
          // measured plan is unchanged when the flag is off.
          const rigDims = rigDimsFromRig(userProfile.rigs?.[0] as any)

          // BUG-2 — DETERMINISTIC minimal-trip night-budget gate (refuse-and-ask).
          // Anchored on the MINIMAL trip (origin → turnaround → origin), NOT the AI's
          // variable per-run itinerary — that variability is why identical input
          // refused inconsistently. Same input → same outcome.
          let reqNights: number | null = null
          if (sessionId) {
            try {
              const s = await prisma.planningSession.findUnique({ where: { id: sessionId }, select: { partialTripData: true } })
              const r = Number((s?.partialTripData as any)?.requestedNights)
              reqNights = Number.isInteger(r) && r > 0 ? r : null
            } catch { /* no budget known → no conflict */ }
          }
          const conflict = reqNights != null
            ? await minimalTripBudget(transitStops, capHours, reqNights, process.env.GOOGLE_MAPS_API_KEY, rigDims)
            : null

          // FEAT-PLANNER-FACTS — instead of overwriting the reply with a canned
          // sentence, drop the over-budget build and let the planner explain and
          // ask in its own words, given the specific measured fact. One retry;
          // if it still builds, the plain server sentence is the backstop.
          const renegotiate = async (fact: string, fallback: string) => {
            const retryMessages = [
              ...messagesForAI,
              { role: 'assistant' as const, content: response },
              {
                role: 'user' as const,
                content: `[SYSTEM REMINDER — measured by the app, authoritative: ${fact} Your last reply built a trip that does not fit, so it was NOT shown to the user. Reply again: do NOT emit an <itinerary> block. In one or two warm sentences say what the app measured and why the plan doesn't fit the ${reqNights} night${reqNights === 1 ? '' : 's'} they asked for, then offer the real choices — add the night(s), drop a stop, or allow longer drive days (say how long) — and ask which they want. Do not repeat an earlier question word for word.]`,
              },
            ]
            const retry = await chatWithAI(retryMessages, userProfile, recentSurpriseDestinations, surpriseVibe, aiCtx)
            if (retry && !/<itinerary>/.test(retry)) {
              // The retry can legitimately carry <drive_cap> / <requestedNights>
              // (the user just agreed to longer days or more nights) — the
              // per-tag handlers already ran on the FIRST reply, so honour the
              // two that matter here before the catch-all strip removes them.
              const capM = retry.match(/<drive_cap>([\s\S]*?)<\/drive_cap>/)
              const capV = capM ? Number(capM[1].trim()) : NaN
              // CAP-CONSENT applies here too: a raise in a reply that still asks is
              // a proposal, not consent (this path is where the 6.5 h leaked in).
              const retryText = retry.replace(/<[a-z_][a-zA-Z0-9_]*>[\s\S]*?<\/[a-z_][a-zA-Z0-9_]*>/g, '').trim()
              const retryAsking = /\?\s*$/.test(retryText)
              const capNow = deriveCapHours(user?.travelProfile, tripDriveCap)
              if (sessionId && Number.isFinite(capV) && capV > capNow && retryAsking) {
                console.log('[AI drive-cap] deferred raise to %sh via renegotiate — reply is still asking (cap in effect %sh)', capV, capNow)
              } else if (sessionId && Number.isFinite(capV) && capV >= 1 && capV <= 16) {
                tripDriveCap = capV
                await mergePartialTripData(sessionId, { driveCapHours: capV }).catch(() => {})
                console.log('[AI drive-cap] sessionId=%s driveCapHours=%s (planning, via renegotiate)', sessionId, capV)
              }
              const rnM = retry.match(/<requestedNights>([\s\S]*?)<\/requestedNights>/)
              const rnV = rnM ? Number(rnM[1].trim()) : NaN
              if (sessionId && Number.isInteger(rnV) && rnV > 0) {
                await mergePartialTripData(sessionId, { requestedNights: rnV }).catch(() => {})
              }
              // Tag names may contain underscores (<drive_cap>) — the old class missed them and leaked the tag to the user.
              response = retry.replace(/<(?!\/?itinerary\b)([a-z_][a-zA-Z0-9_]*)>[\s\S]*?<\/\1>/g, '').trim()
            } else {
              response = fallback
            }
          }

          if (conflict) {
            console.warn(
              '[AI budget-conflict] sessionId=%s refusing — turnaround=%s minNeeded=%d requested=%d',
              sessionId ?? '(none)', conflict.turnaroundName, conflict.minNeeded, reqNights,
            )
            await renegotiate(
              `the drive to ${conflict.turnaroundName} needs at least ${conflict.minNeeded} night${conflict.minNeeded === 1 ? '' : 's'} at the ${capHours}-hour daily limit; the user asked for ${reqNights}.`,
              buildBudgetConflictAsk(conflict.turnaroundName, conflict.minNeeded, reqNights!),
            )
          } else {
            // No budget conflict → run the normal transit splice on the AI's full route.
            const { stops: splicedStops, inserts, legNotices, legGeometry } = await planTransitInserts(
              transitStops, capHours, process.env.GOOGLE_MAPS_API_KEY, rigDims,
            )
            // FEAT-HAZARD-WARN — DB-driven hazard check on the (spliced) plan.
            // Mutates firing-hazard text onto the arriving stop's violationNotes
            // (same channel as HERE notices → RouteAdvisory) and returns a prose
            // advisory. Independent of USE_HERE_ROUTING (DB + Google geocode only),
            // and fully fail-soft inside detectStopHazards — never blocks emission.
            const hazardResult = await detectStopHazards(
              splicedStops, userProfile.rigs?.[0] as any, process.env.GOOGLE_MAPS_API_KEY, legGeometry,
            )
            // Re-serialize when a transit stop was inserted, OR a leg carried a HERE
            // restriction notice, OR a DB hazard fired — any of these means
            // splicedStops now carry per-leg violationNotes that must reach the plan
            // view. None of them → untouched, byte-identical to before.
            const addedNights = inserts.reduce((n, ins) => n + ins.towns.length, 0)
            const builtNightsPre = transitStops.reduce(
              (n: number, s: any) => n + (s.type === 'OVERNIGHT_ONLY' ? 1 : (s.nights ?? 0)), 0,
            )
            // FEAT-PLANNER-FACTS — the AI's route (via its chosen stops) forces an
            // overnight that pushes the trip PAST the agreed length. Don't silently
            // add the night: drop the build, remember the leg fact for next turn's
            // <drive_facts>, and let the planner ask.
            if (reqNights != null && addedNights > 0 && builtNightsPre + addedNights > reqNights) {
              const ins0 = inserts[0]
              const legFrom = (transitStops[ins0.afterIndex] as any)?.locationName ?? 'the previous stop'
              const legTo = (transitStops[ins0.afterIndex + 1] as any)?.locationName ?? 'the next stop'
              const legHours = Math.round(ins0.legHours * 10) / 10
              const total = builtNightsPre + addedNights
              if (sessionId) {
                await mergePartialTripData(sessionId, { lastOverBudget: { legFrom, legTo, legHours, addedNights, total } }).catch(() => {})
              }
              console.warn('[AI over-budget-insert] sessionId=%s %s→%s %sh adds %d night(s) → %d > requested %d; renegotiating',
                sessionId ?? '(none)', legFrom, legTo, legHours, addedNights, total, reqNights)
              await renegotiate(
                `with the stops you chose, the ${legFrom} → ${legTo} drive is ${legHours} hours, over the ${capHours}-hour daily limit, which adds ${addedNights} overnight on the road — ${total} nights total.`,
                `With those stops, the ${legFrom} → ${legTo} drive is about ${legHours} hours — over your ${capHours}-hour daily limit — which adds an overnight and makes it ${total} nights instead of ${reqNights}. Want me to make it ${total} nights, drop a stop, or allow a longer drive day for that leg?`,
              )
            } else if (inserts.length > 0 || legNotices.length > 0 || hazardResult.hitCount > 0) {
            if (sessionId) await mergePartialTripData(sessionId, { lastOverBudget: null }).catch(() => {})
            // Bump totalNights by the inserted nights (each OVERNIGHT_ONLY = 1) so
            // the nightsShortfall check below doesn't false-flag our own inserts.
            const prevTotal = typeof transitItin.totalNights === 'number' ? transitItin.totalNights : 0
            const splicedItin = { ...transitItin, stops: splicedStops, totalNights: prevTotal + addedNights }
            const json = JSON.stringify(splicedItin, null, 2)

            // PLAN-IS-TRUTH (Part 2, step 3) — GROUNDED drive-time note. Built ONLY
            // from inserts MADE THIS TURN, using the REAL measured legHours from the
            // Directions check — no 2nd AI call, no fabrication. A re-emit that
            // inserts nothing produces NO transit note (prior overnights are never
            // re-announced — they're "answered" segments the check skipped). The AI
            // itself stays silent on drive-time compliance (planner prompt, step 4),
            // so this server note is the single authoritative statement about why a
            // transit stop exists. afterIndex+1 is the segment's far real stop (only
            // empty adjacent real→real segments ever yield an insert).
            // Shared phrasing with the post-build recheck (recheckLongLegs) so a
            // transit note reads identically whether it came from planning or a
            // later edit. The HERE restriction advisory (buildViolationAdvisory)
            // rides alongside it — same plumbing — using HERE's actual notice text.
            const transitNote = buildTransitNote(inserts, transitStops, capHours) ?? ''
            const violationAdvisory = buildViolationAdvisory(legNotices) ?? ''
            const hazardAdvisory = hazardResult.hitCount > 0 ? HAZARD_ADVISORY : ''
            // STOPS-MISMATCH NOTE (2026-09-05): the planner keeps building fewer
            // stops than asked without saying so (three runs in a row, rule 4
            // ignored). The app knows both numbers, so the app says it — unless
            // the reply already does.
            let stopsNote = ''
            try {
              const askedStops = parseRequestedStops((messages as any[]).filter(m => m?.role === 'user').map(m => String(m?.content ?? '')))
              // Road-night towns COUNT as stops (a stop is a place the trip sleeps).
              const builtStops = splicedStops.filter((st: any) => st.type !== 'HOME').length
              const alreadySaid = /(\b\d+|four|three|five|six)\s+stops?\b[^.]*\b(asked|wanted|mentioned|requested)|left out the \w+ stop|(fourth|fifth|extra) stop/i.test(response)
              if (askedStops != null && builtStops > 0 && builtStops < askedStops && !alreadySaid) {
                const nightsTotal = (splicedItin as any).totalNights
                stopsNote = `You asked for ${askedStops} stops; this plan has ${builtStops}${typeof nightsTotal === 'number' ? ` (each stop needs a night, and ${nightsTotal} night${nightsTotal === 1 ? '' : 's'} covers up to ${nightsTotal})` : ''} — add a night or name a stop to swap and I'll adjust.`
              }
            } catch { /* note is best-effort */ }
            const note = [transitNote, violationAdvisory, hazardAdvisory, stopsNote].filter(Boolean).join(' ')

            // Re-serialize the <itinerary> block AND prepend the grounded note to the
            // prose (immediately before the block = the end of the visible reply;
            // cleanChatText strips the tags but keeps the note). Handle the closed
            // form and the truncated/unclosed form (mirrors parseItineraryBlock).
            const replacement = note
              ? `${note}\n\n<itinerary>\n${json}\n</itinerary>`
              : `<itinerary>\n${json}\n</itinerary>`
            if (/<itinerary>[\s\S]*?<\/itinerary>/.test(response)) {
              response = response.replace(/<itinerary>[\s\S]*?<\/itinerary>/, replacement)
            } else {
              response = response.replace(/<itinerary>[\s\S]*/, replacement)
            }
            console.log(
              '[AI transit-insert] sessionId=%s inserted %d transit stop(s) across %d leg(s) (+%d night(s)); %d leg(s) with restriction notice(s)',
              sessionId ?? '(none)', addedNights, inserts.length, addedNights, legNotices.length,
            )
            }
          }
        } else {
          // PRE-BUILD BUDGET GATE (BUG-MILEAGE-OPENING-TURN, structural). No
          // <itinerary> this turn → the model has NOT built (e.g. the opening
          // "KC to Bangor, 3 nights" turn, before a start date). The app — not the
          // model — owns the minimum-nights number, so compute it deterministically
          // here from {origin, destination, length} the moment both destination and
          // length are known (NO start date required), and on a conflict overwrite
          // the reply with the SAME authoritative question the post-build gate uses.
          // This makes the budget behaviour identical across runs instead of a
          // per-run prompt gamble. Mutually exclusive with the post-build gate above
          // (that runs ONLY when an itinerary exists; this ONLY when it does not).
          if (sessionId) {
            const s = await prisma.planningSession.findUnique({ where: { id: sessionId }, select: { partialTripData: true } })
            const pb = (s?.partialTripData as any) ?? null
            const destination: string | null = typeof pb?.destination === 'string' ? pb.destination : null
            const rn = Number(pb?.requestedNights)
            const reqNights: number | null = Number.isInteger(rn) && rn > 0 ? rn : null
            // Origin: captured this/prior turn, else the profile home city.
            const originName: string | null =
              ((userProfile as any).capturedOrigin as string | null) ??
              (userProfile?.homeCity
                ? `${userProfile.homeCity}${userProfile.homeState ? ', ' + userProfile.homeState : ''}`
                : null)

            // COST GATE — only spend a Directions call when destination OR the
            // requested length CHANGED vs the prior persisted values (snapshotted
            // before this turn's writes). A settled conversation ("why so many
            // nights?", small talk) re-uses the prior answer and skips the call.
            const changed = destination !== priorDestination || reqNights !== priorRequestedNights

            if (originName && destination && reqNights != null && changed) {
              const capHours = deriveCapHours(user?.travelProfile, tripDriveCap)
              // FEAT-HERE-ROUTING — same rig-dims threading as the main splice
              // path; ignored when USE_HERE_ROUTING is off.
              const rigDims = rigDimsFromRig(userProfile.rigs?.[0] as any)
              const userMsgs = (messages as any[])
                .filter(m => m?.role === 'user')
                .map(m => String(m?.content ?? ''))
              const roundTrip = hasRoundTripIntent(userMsgs, [originName])
              // Synthetic minimal name-stops; minimalTripBudget routes by name.
              const home = { locationName: originName, type: 'HOME', nights: 0 }
              const dest = { locationName: destination, type: 'DESTINATION', nights: reqNights }
              const synthetic = roundTrip
                ? [home, dest, { locationName: originName, type: 'DESTINATION', nights: 0 }]
                : [home, dest]
              // FEAT-PLANNER-FACTS — the planner already saw <drive_facts> this
              // turn when facts were available, so it explains the minimum itself.
              // The canned overwrite runs ONLY when no facts could be measured
              // (driveFacts null) — the old deterministic backstop.
              if (!driveFacts) {
                const conflict = await minimalTripBudget(synthetic as any, capHours, reqNights, process.env.GOOGLE_MAPS_API_KEY, rigDims)
                if (conflict) {
                  response = buildBudgetConflictAsk(conflict.turnaroundName, conflict.minNeeded, reqNights)
                  console.warn(
                    '[AI budget-conflict:pre-build:no-facts] sessionId=%s shape=%s turnaround=%s minNeeded=%d requested=%d',
                    sessionId, roundTrip ? 'ROUND_TRIP' : 'ONE_WAY', conflict.turnaroundName, conflict.minNeeded, reqNights,
                  )
                }
              }
            } else if (!changed) {
              console.log('[AI budget-conflict:pre-build] sessionId=%s skipped (cost gate — destination/length unchanged)', sessionId)
            }
          }
        }
      } catch (e: any) {
        console.error('[AI transit-insert] failed (non-fatal) sessionId=%s: %s', sessionId ?? '(none)', e?.message ?? e)
      }
    }

    // PLANNING-RETENTION (A1) — after any planning turn whose final reply carries
    // a parseable <itinerary>, snapshot the agreed stop-set onto the session so
    // the NEXT turn can re-ground the model even once the early turns scroll out
    // of the HISTORY_CAP window (the root cause of the dropped-stops bug). Merge,
    // never overwrite, so the captured origin is preserved. Planning only; modify
    // mode edits a persisted trip and uses buildLiveTripState instead.
    // BUG-TRIP-NIGHTS Build 2a (Gap A) — deterministic SHORTFALL truth net.
    // Stamped on the chat response so the client can later surface a banner.
    // AI-scoped by construction: only this planning parse point (context !==
    // 'modify', parseable <itinerary>) computes it. Manual trips go through
    // createTrip/createStop and never reach here.
    let nightsShortfall: { claimed: number; built: number; gap: number } | null = null
    if (context !== 'modify') {
      const builtItin = parseItineraryBlock(response)
      const builtStops = Array.isArray(builtItin?.stops) ? builtItin.stops : null
      if (builtStops && builtStops.length > 0) {
        // Count nights with the SAME OVERNIGHT_ONLY=1 rule as the canonical
        // recomputeStopDates (controllers/trips.ts) so this never disagrees
        // with the persisted total. Do NOT use the raw s.nights mapping below.
        const builtNights = builtStops.reduce(
          (n: number, s: any) => n + (s.type === 'OVERNIGHT_ONLY' ? 1 : (s.nights ?? 0)),
          0,
        )
        const claimedNights = typeof builtItin?.totalNights === 'number' ? builtItin.totalNights : null
        // Flag ONLY a shortfall — the AI claimed more nights than it built.
        if (claimedNights != null && claimedNights > builtNights) {
          nightsShortfall = { claimed: claimedNights, built: builtNights, gap: claimedNights - builtNights }
        }

        if (sessionId) {
          const agreedStops = builtStops.map((s: any) => ({
            name: s.locationName ?? null,
            state: s.locationState ?? null,
            type: s.type ?? 'DESTINATION',
            nights: typeof s.nights === 'number' ? s.nights : 0,
          }))
          try {
            await mergePartialTripData(sessionId, { agreedStops })
          } catch (e: any) {
            console.error('[AI planning-retention] agreedStops persist failed for sessionId=%s: %s', sessionId, e?.message)
          }
        }
      }
    }

    // FEAT-ORIGIN-RESOLVER — CATCH-ALL TAG STRIP. The known handlers above each
    // consume one expected machine tag; anything they didn't consume (e.g. a
    // hallucinated <requestedDestination>) would otherwise leak to visible chat.
    // Final sweep BEFORE persist + send so both the stored history and the reply
    // are clean. Scoped to the machine-tag SHAPE — a single lower/camelCase word,
    // matching open+close (no spaces/attributes) — so it can NEVER eat legitimate
    // prose like "5 < 10", "x<y", or "a < b". <itinerary> is preserved (the client
    // parses it); every metadata tag was already stripped by its handler above.
    if (context !== 'modify') {
      response = response
        // matched pairs <name>…</name>, name ≠ itinerary
        .replace(/<(?!\/?itinerary\b)([a-z_][a-zA-Z0-9_]*)>[\s\S]*?<\/\1>/g, '')
        // any stray opener/closer of the same shape, name ≠ itinerary
        .replace(/<\/?(?!itinerary\b)[a-z_][a-zA-Z0-9_]*>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }

    // Persist conversation to the appropriate field based on context.
    // 'modify' context → modifyConversation; all others → aiConversation.
    // Reuse liveTrip for modify (already fetched + ownership verified above).
    if (tripId) {
      const tripForPersist = liveTrip ?? await prisma.trip.findFirst({ where: { id: tripId, userId: req.user!.id } })
      if (tripForPersist) {
        // AI-MESA-10 — persist RAW content (tags intact), never the blanket
        // "[✓ change already applied]" annotation: persist time knows nothing
        // about applies, and that marker is what made reloaded history lie.
        // Assistant turns carry their actions [{id, action, applied,
        // appliedAt}]; `applied` flips ONLY via stampModifyActionApplied on
        // the trip-mutation endpoints. Re-posted turns from this session are
        // matched back to their stored entries by exact content so existing
        // stamps survive the overwrite-style persist below.
        const stored = Array.isArray(tripForPersist.modifyConversation)
          ? (tripForPersist.modifyConversation as any[])
          : []
        const usedStored = new Set<number>()
        const carryActions = (content: string) => {
          const idx = stored.findIndex(
            (e, i) => !usedStored.has(i) && e?.role === 'assistant' && Array.isArray(e.actions) && e.content === content,
          )
          if (idx < 0) return undefined
          usedStored.add(idx)
          return stored[idx].actions
        }

        const persistable = messages
          .filter((m: any) => m.role !== 'system')
          .map((m: any) => {
            if (m.role !== 'assistant') return { role: m.role, content: m.content }
            const actions = context === 'modify' ? carryActions(m.content) : undefined
            return { role: 'assistant', content: m.content, ...(actions ? { actions } : {}) }
          })
        persistable.push({
          role: 'assistant',
          content: response,
          ...(context === 'modify' && parsedActions.length
            ? { actions: parsedActions.map(a => ({ ...a, applied: false, appliedAt: null })) }
            : {}),
        })

        await prisma.trip.update({
          where: { id: tripId },
          data: context === 'modify'
            ? { modifyConversation: persistable }
            : { aiConversation: persistable },
        })
      }
    }

    // modifyOutcome tells the client how to render a modify-mode turn:
    // 'proposal' → Apply card(s), 'clarify' → plain question (no warning),
    // 'failed' → the inline "couldn't apply" notice. null for non-modify
    // chats. actions[] (AI-MESA-10) is the server-parsed list of proposed
    // changes for this turn — [{id, action, applied:false}] — and is the
    // client's ONLY sanctioned source of applyable changes; `message` still
    // contains raw <modify> tags solely for the pre-Phase-2 client.
    res.json({
      message: response,
      modifyOutcome,
      actions: parsedActions.map(a => ({ ...a, applied: false })),
      // BUG-TRIP-NIGHTS Build 2a — Gap A shortfall ({ claimed, built, gap }) or
      // null. Distinct from modifyOutcome (modify-only); planning builds only.
      nightsShortfall,
    })
  } catch (err: any) {
    console.error('[AI chat error] message:', err?.message)
    console.error('[AI chat error] status:', err?.status)
    console.error('[AI chat error] error type:', err?.error?.type)
    console.error('[AI chat error] full:', err)
    next(err)
  }
}

export async function getChatHistory(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.tripId, userId: req.user!.id },
      select: { aiConversation: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)
    res.json(trip.aiConversation || [])
  } catch (err) { next(err) }
}

export async function getModifyHistory(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.tripId, userId: req.user!.id },
      select: { modifyConversation: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)
    // AI-MESA-10 — legacy degrade: pre-MESA-10 histories contain the old
    // blanket "[✓ change already applied]" marker, written with no knowledge
    // of actual apply state. We can't verify those retroactively, so serve
    // them as neutral text — never a false checkmark. New-format entries
    // pass through untouched (content + per-action applied state).
    const conv = Array.isArray(trip.modifyConversation) ? (trip.modifyConversation as any[]) : []
    res.json(conv.map(e =>
      e?.role === 'assistant' && typeof e.content === 'string'
        ? { ...e, content: neutralizeLegacyMarkers(e.content) }
        : e,
    ))
  } catch (err) { next(err) }
}

export async function generateItinerary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { messages } = req.body
    // Daily cap for non-paying, non-trial accounts. Quiet cost protection.
    if (await enforceFreeAiCap(req, res)) return
    if (await enforcePerUserDailyCap(req, res)) return
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        rigs: { where: { isDefault: true } },
        travelProfile: true,
        parties: {
          where: { isDefault: true },
          include: { people: true, pets: true },
          take: 1,
        },
      },
    })

    const response = await chatWithAI(
      messages,
      {
        rigs: user?.rigs,
        travelProfile: user?.travelProfile,
        homeLocation: user?.homeLocation,
        defaultParty: serializeParty(user?.parties?.[0] ?? null),
      },
      undefined,
      undefined,
      { userId: req.user!.id },
    )

    res.json({ response })
  } catch (err) { next(err) }
}

export async function generatePackingList(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { tripId } = req.body
    // Daily cap for non-paying, non-trial accounts. Defense-in-depth — the
    // route is already behind requireFeature('packingListGenerator') which
    // gates on subscriptionTier === 'PRO' OR trialEndsAt > now, so this
    // check is unreachable for Free users in practice. Kept for symmetry
    // with the other AI-consuming controllers.
    if (await enforceFreeAiCap(req, res)) return
    if (await enforcePerUserDailyCap(req, res)) return
    const trip = await prisma.trip.findFirst({
      where: { id: tripId, userId: req.user!.id },
      include: { stops: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        rigs: { where: { isDefault: true } },
        travelProfile: true,
        parties: {
          where: { isDefault: true },
          include: { people: true, pets: true },
          take: 1,
        },
      },
    })

    const packingList = await generatePackingListAI(trip, user, { userId: req.user!.id, tripId })
    res.json(packingList)
  } catch (err) { next(err) }
}

export async function analyzeFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const feedbackItems = await prisma.feedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    const analysis = await analyzeFeedbackAI(feedbackItems, { userId: req.user!.id })
    res.json({ analysis })
  } catch (err) { next(err) }
}
