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
  for (const c of text.split(/(?<=[?.!])\s+/)) {
    if (c.includes('?') && ORIGIN_ASK_KEYWORDS.test(c)) return true
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
function extractFromXtoY(text: string | undefined | null): string | null {
  if (!text) return null
  const WORD = "[A-Za-z][A-Za-z.'-]*"
  const NOT_KW = "(?!(?:to|from)\\b)"            // a route keyword is never a city token
  const ORIGIN = `(${NOT_KW}${WORD}(?:\\s+${NOT_KW}${WORD}){0,3}(?:,\\s*[A-Za-z]{2,})?)`
  const DEST   = `(${NOT_KW}${WORD}(?:\\s+${NOT_KW}${WORD}){0,3})`

  let origin: string | null = null
  let dest: string | null = null
  let m = text.match(new RegExp(`\\bfrom\\s+${ORIGIN}\\s+to\\s+${DEST}`, 'i'))   // from X to Y
  if (m) { origin = m[1]; dest = m[2] }
  else {
    m = text.match(new RegExp(`\\bto\\s+${DEST}\\s+from\\s+${ORIGIN}`, 'i'))      // to Y from X
    if (m) { dest = m[1]; origin = m[2] }
  }
  if (!origin || !dest) return null
  origin = origin.trim()
  dest = dest.trim()

  // Guard 1 — first origin token must not be a non-place word.
  const STOP = new Set([
    'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
    'january','february','march','april','may','june','july','august','september','october','november','december',
    'morning','noon','afternoon','evening','night','midnight','today','tomorrow','yesterday',
    'home','work','here','there','point','to','from','the','a','an','my','our','your',
    'now','time','start','finish','scratch','nowhere','everywhere','anywhere','somewhere',
    'it','this','that','bad','worse','dawn','dusk',
  ])
  const firstTok = origin.split(/[\s,]+/)[0].toLowerCase()
  if (STOP.has(firstTok)) return null

  // Guard 2 — proper-noun signal: at least one side must be a named place.
  if (!/[A-Z]/.test(origin) && !/[A-Z]/.test(dest)) return null

  return normalizeOriginCase(origin)
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
    'Every trip modification you agree to perform MUST include a <modify>…</modify> JSON block.',
    'If you say you are adding, removing, or changing something but do NOT emit a <modify> tag,',
    'NO change actually happens — the UI has no other way to apply modifications.',
    'Never say "Applied to trip", "Done!", "Added!", or any confirmation phrase without also emitting the <modify> tag.',
    'If you cannot determine all required parameters, ask the user — do not claim to have done it.',
    'MULTI-STEP CHANGES (AI-MESA-10 contract): when the user\'s request requires SEVERAL changes (e.g. adding multiple stops for a return route), emit ONE <modify> block PER change, in execution order, each on its own line. Every block is a SEPARATE PROPOSAL — the user must click Apply on each one individually, in order. NOTHING you emit is ever applied automatically.',
    'NEVER claim a change has been applied. Changes happen ONLY after the user clicks Apply in the UI. Never write "[✓ change already applied]", "[✓ applied]", "[applied]" or any similar bracketed marker yourself — those markers are added by the SYSTEM to past turns based on verified apply state, and writing one yourself is a serious honesty violation (it will be stripped, and the user will see a claim with no change). If a past turn of yours shows "[proposal — NOT applied…]", that change never happened — do not assume or assert it did.',
    'CLARIFYING QUESTIONS: When you need more information from the user before you can propose a change (e.g. they have not said which stop, how many nights, or which destination), DO NOT emit a <modify> tag. Instead, wrap your ENTIRE clarifying reply in a <clarify>…</clarify> tag — e.g. <clarify>Which stop did you mean — Stop 1 or Stop 2?</clarify>. The user sees only the text inside the tag, so write a normal, friendly question there. Emit <modify> blocks ONLY when proposing actionable changes; emit <clarify> ONLY when asking for information you still need. Never emit both in the same reply, and never neither — every modify-mode reply is either one-or-more <modify> blocks or exactly one <clarify>.',
    '',
    'USER VOCABULARY — read carefully:',
    'Each line in the stop list below shows a user-facing label ("Starting point" / "Stop N" / "Return home") and the stop NAME, e.g. "Stop 2: [EXAMPLE_STOP_2], [STATE]". Reference stops by NAME — the name is the reliable anchor; the "Stop N" number is only there to match the user\'s own wording:',
    '- When TALKING TO THE USER in prose, refer to stops by their user-facing label and locationName (e.g. "I\'ll remove [EXAMPLE_STOP_1]" or "before your starting point" or "after Stop 2"). NEVER say "stop 1" to mean the home departure.',
    '- When EMITTING <modify> JSON, identify any existing stop by its locationName from the list ([EXAMPLE_STOP_1], [EXAMPLE_STOP_2], etc.). For add_stop, anchor the insertion with after_stop set to the EXACT locationName of the stop the new one goes AFTER (see the add_stop format below) — names are the reliable anchor, not stop numbers.',
    '- When the user says "first stop" / "stop 1" / "the second stop" / "the last stop", they almost always mean a NUMBERED DESTINATION — not the home departure and not the return-home entry. If the request is ambiguous, ASK BEFORE EMITTING a <modify> tag: "Just to confirm — you mean [first destination], not your home departure?"',
    '- Concrete example: trip is "Starting point: [HomeCity] | Stop 1: [EXAMPLE_STOP_1] | Stop 2: [EXAMPLE_STOP_2] | Return home: [HomeCity]". User says "remove the first stop" → that means [EXAMPLE_STOP_1], not [HomeCity]. Confirm with the user, then emit <modify>{"action":"remove_stop","locationName":"[EXAMPLE_STOP_1]"}</modify>.',
    '',
    'DRIVE-TIME CONSTRAINT — HARD RULE: The user has a max daily drive time set in their travelProfile (`maxDriveHours`, in hours). Treat this as a HARD upper bound on each leg between consecutive stops, NOT an average across the trip.',
    '  Conversion: at typical RV highway speeds (~55 mph), 1 hour ≈ 55 miles. Add ~30% slack for non-highway routing and stops. So 6 hours ≈ ~330 miles per leg, 8 hours ≈ ~440 miles per leg.',
    '  If a planned leg between two consecutive stops would exceed the user\'s limit, you MUST insert one or more OVERNIGHT_ONLY stops to break the leg up. For each transit stop you propose, you MUST estimate the distance from the previous stop and confirm it falls within the limit (with the ~30% slack noted above). Distance from the destination is irrelevant — only distance from the previous stop. If the most well-known transit city for the route is too far from the previous stop, pick a closer city instead, even if that means adding an extra overnight stop. It is better to insert two short transit days than one too-long day. When in doubt, err on the side of MORE transit stops, not fewer.',
    '  Fallback values when fields are null:',
    '    - If `maxDriveHours` is null but `maxMilesPerDay` is set, use `maxMilesPerDay` directly as the per-leg limit.',
    '    - If both are null, default to 350 miles per leg.',
    '  Override conditions: if the user explicitly says in this conversation that they want to drive straight through, do a long day, or skip overnight stops, that overrides this rule for that trip only. Otherwise, NEVER emit a <modify> that creates a leg you believe will exceed the limit.',
    '  Specifically for modify actions: if removing a stop would create an over-long leg between the two surrounding stops, propose inserting a transit stop instead, or warn the user before emitting the modify. If adding a stop creates an over-long leg into or out of the new stop, suggest a transit stop along the way. Adding a return-home stop is a special case of this: it creates a final leg from the current last stop back to the user\'s home — verify that leg fits within maxDriveHours and propose an OVERNIGHT_ONLY transit stop along the route if not.',
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
    '  nights parsing rules: "one night" = 1 | "two nights" or "a couple nights" = 2 | "three nights" = 3 | "a few nights" = 2 | "the weekend" = 2 | "three days" = 2 (days minus 1) | default to 1 if ambiguous. Parse nights EXACTLY as stated — do not infer or round up.',
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
    'Remove a stop:',
    '<modify>{"action":"remove_stop","locationName":"[EXAMPLE_DESTINATION_CITY]"}</modify>',
    '',
    'Change nights at a stop:',
    '<modify>{"action":"change_nights","locationName":"[EXAMPLE_DESTINATION_CITY]","nights":3}</modify>',
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

export async function chat(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { messages, tripId, sessionId, context, rigId, adHocVehicle } = req.body
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
    if (!(userProfile as any).capturedOrigin) {
      const detected = extractFromXtoY(lastUserMsg?.content)
      if (detected) {
        ;(userProfile as any).capturedOrigin = detected
        if (sessionId) {
          await mergePartialTripData(sessionId, { origin: detected })
            .catch((e: any) => console.error('[AI origin-capture:from-x-to-y] persist failed for sessionId=%s: %s', sessionId, e?.message))
        }
      }
    }

    const aiCtx = { userId, sessionId: sessionId ?? null, tripId: tripId ?? null }
    // SCOPE-GUARD-2 — opening turn of a NEW planning session: not modify, and no
    // assistant reply exists yet in the history. Biases the scope-guard toward
    // trip-intent so a terse opener ("[Place] and back") is planned, not refused.
    const isOpeningTurn = context !== 'modify' && !messages.some((m: any) => m.role === 'assistant')
    let response = await chatWithAI(messagesForAI, userProfile, recentSurpriseDestinations, surpriseVibe, aiCtx, isOpeningTurn, context === 'modify')

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
      const hasClarify = /<clarify>/.test(response)
      console.log('[AI modify] response hasModify=%s hasClarify=%s preview=%s', hasModify, hasClarify, response.slice(0, 200))

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
      else if (/<clarify>/.test(response)) modifyOutcome = 'clarify'
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
    //   - response contains a parseable <itinerary> whose stops[0].type === 'HOME'
    //   - the HOME city appears in NONE of the user's own messages
    const hasHomeOnFile = !!(userProfile.homeCity || userProfile.homeLocation)
    if (context !== 'modify' && !hasHomeOnFile) {
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

    // ORIGIN-FIX — capture the AI's structured <origin> tag (emitted on the turn
    // it confirms the user's starting location). Strip it from the displayed
    // message (mirrors the <clarify> unwrap) and persist it to the session so the
    // no-home directive stops re-firing on later turns. Guarded on sessionId.
    const originMatch = response.match(/<origin>([\s\S]*?)<\/origin>/)
    if (originMatch) {
      response = response.replace(/<origin>[\s\S]*?<\/origin>/g, '').trim()
      const captured = originMatch[1].trim()
      if (sessionId && captured) {
        try {
          await mergePartialTripData(sessionId, { origin: captured })
        } catch (e: any) {
          console.error('[AI origin-capture] persist failed for sessionId=%s: %s', sessionId, e?.message)
        }
      }
    }

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

    // REQUESTED-NIGHTS SINGLE-SHOT FALLBACK — under the state-and-proceed opening
    // flow a one-shot prompt ("…6 days…") can state the length AND emit the
    // <itinerary> in the SAME turn; if the model didn't append <requestedNights>
    // on that turn, the target would never persist and reconcileNights would
    // no-op ('no-target'), leaving the built trip short. Backstop: when THIS turn
    // builds an itinerary, no valid tag was captured above, and no target is
    // already locked, deterministically parse an EXPLICIT integer duration from
    // the user's latest message and persist it. Conservative — explicit digits
    // only; fuzzy lengths stay the model's job via the tag.
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

        // LENGTH — captured target is primary; fall back to the itinerary's summed
        // nights (OVERNIGHT_ONLY counts as 1, mirroring the reconciler).
        const capturedNights = Number(gatePtd?.requestedNights)
        const summedNights = gateStops.reduce(
          (n, s) => n + (s?.type === 'OVERNIGHT_ONLY' ? 1 : (Number(s?.nights) || 0)),
          0,
        )
        const lengthOk = (Number.isInteger(capturedNights) && capturedNights > 0) || summedNights > 0

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
