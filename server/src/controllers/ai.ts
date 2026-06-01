import { Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { chatWithAI, generatePackingListAI, analyzeFeedbackAI, generatePlanningContextSummary } from '../services/ai'
import { parseTripDate } from '../utils/dates'

// Soft cap: inject a "wrap up" system message and let Claude actually respond
// (so it has a chance to emit the <itinerary> JSON block).
// Hard cap: short-circuit purely for cost protection.
const SOFT_CAP = 35
const HARD_CAP = 60

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
  const isTrialActive = u.trialEndsAt && now < new Date(u.trialEndsAt)
  const isPro = u.subscriptionTier === 'PRO'
  const isOwner = u.isOwner === true
  if (isPro || isTrialActive || isOwner) return false

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

const HARD_CAP_RESPONSE =
  "This planning session has gotten really long! 🗺️ To keep things snappy, " +
  "let's wrap this one up and start fresh. Your conversation is saved — " +
  "you can start a new trip and reference what we discussed."

const SOFT_CAP_NUDGE =
  '\n\nIMPORTANT: This conversation has gotten long. If you have enough information ' +
  'to build a trip itinerary, please wrap up your response and emit the ' +
  '<itinerary>...</itinerary> JSON block now. Do not ask further clarifying ' +
  'questions unless absolutely necessary.'

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
function buildLiveTripState(trip: any): string {
  const stops: any[] = trip.stops ?? []
  const stopNames = stops.map((s: any) => s.locationName.toLowerCase())

  // User-facing vocabulary, computed from the data model.
  // - HOME entry (data: order 1, type HOME) is the "Starting point" — NOT "Stop 1"
  // - On loop trips, the closing return-home entry (last stop, type DESTINATION,
  //   nights 0, locationName matches HOME) is the "Return home" — NOT "Stop N"
  // - Destinations between are renumbered "Stop 1..N" for the user, where Stop 1
  //   is the first destination AFTER home.
  // The internal `order` field is preserved on every line so the AI still has the
  // 1-indexed data reference it needs for <modify> action's afterStopOrder field.
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
  const isLoopTrip = !!(
    homeStop &&
    lastStop &&
    lastStop !== homeStop &&
    isReturnHome(lastStop)
  )
  const isOneWayTrip = !!(
    homeStop &&
    lastStop &&
    lastStop !== homeStop &&
    !isReturnHome(lastStop)
  )

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
      `[${userLabel} — internal order ${s.order}] ${name}`,
      s.type,
      `${s.nights} night${s.nights !== 1 ? 's' : ''}`,
      s.bookingStatus,
    ]
    if (s.campgroundName) parts.push(`campground: ${s.campgroundName}`)
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

  return [
    '=== MODIFY MODE — TRIP MODIFICATION INSTRUCTIONS ===',
    '',
    'CRITICAL: You are in trip MODIFY mode. The user is editing an existing trip.',
    'Every trip modification you agree to perform MUST include a <modify>…</modify> JSON block.',
    'If you say you are adding, removing, or changing something but do NOT emit a <modify> tag,',
    'NO change actually happens — the UI has no other way to apply modifications.',
    'Never say "Applied to trip", "Done!", "Added!", or any confirmation phrase without also emitting the <modify> tag.',
    'If you cannot determine all required parameters, ask the user — do not claim to have done it.',
    '',
    'USER VOCABULARY — read carefully:',
    'Each line in the stop list below has BOTH a user-facing label ("Starting point" / "Stop N" / "Return home") AND the internal data order ("internal order N"). Use the right one in the right place:',
    '- When TALKING TO THE USER in prose, refer to stops by their user-facing label and locationName (e.g. "I\'ll remove Williams" or "before your starting point" or "after Stop 2"). NEVER say "stop 1" to mean the home departure.',
    '- When EMITTING <modify> JSON, the locationName field uses the actual location name (Williams, Sedona, etc.); the afterStopOrder field uses the INTERNAL order integer from the stop list below.',
    '- When the user says "first stop" / "stop 1" / "the second stop" / "the last stop", they almost always mean a NUMBERED DESTINATION — not the home departure and not the return-home entry. If the request is ambiguous, ASK BEFORE EMITTING a <modify> tag: "Just to confirm — you mean [first destination], not your home departure?"',
    '- Concrete example: trip is "Starting point: Mesa | Stop 1: Williams | Stop 2: Sedona | Return home: Mesa". User says "remove the first stop" → that means Williams, not Mesa. Confirm with the user, then emit <modify>{"action":"remove_stop","locationName":"Williams"}</modify>.',
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
    '  - If any Person has accessibilityNeeds set (JSON with flags like wheelchair, paved_path, accessible_restroom, near_facility, level_site, low_elevation), filter campground suggestions to ADA/accessible sites and avoid steep or rough-terrain stops.',
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
    '<modify>{"action":"add_stop","locationName":"Sedona","locationState":"AZ","type":"DESTINATION","nights":1,"afterStopOrder":1}</modify>',
    '  afterStopOrder: the INTERNAL order integer of the stop AFTER which to insert (see "internal order N" in the stop list below). Omit or set to null to append at end.',
    '  nights parsing rules: "one night" = 1 | "two nights" or "a couple nights" = 2 | "three nights" = 3 | "a few nights" = 2 | "the weekend" = 2 | "three days" = 2 (days minus 1) | default to 1 if ambiguous. Parse nights EXACTLY as stated — do not infer or round up.',
    '',
    'Add a return-home stop (converts a one-way trip into a round trip):',
    '<modify>{"action":"add_stop","locationName":"Mesa","locationState":"AZ","type":"HOME","nights":0}</modify>',
    '  Use type "HOME" and nights 0 only when adding a closing return-home leg.',
    '  locationName MUST match the user\'s home city (homeName in the trip context).',
    '  Omit afterStopOrder so it appends at the end.',
    '',
    'Remove a stop:',
    '<modify>{"action":"remove_stop","locationName":"Sedona"}</modify>',
    '',
    'Change nights at a stop:',
    '<modify>{"action":"change_nights","locationName":"Sedona","nights":3}</modify>',
    '',
    'Suggest a campground at a stop:',
    '<modify>{"action":"suggest_campground","locationName":"Sedona","campgroundName":"Manzanita Campground"}</modify>',
    '',
    'Shift the entire trip to a new start date:',
    '<modify>{"action":"shift_trip_dates","newStartDate":"2026-08-09"}</modify>',
    '  Use this when the user wants to move the WHOLE trip forward or backward in time (e.g. "push trip to August 9", "start two weeks later", "move trip back to next month", "delay until after Labor Day"). Every stop shifts by the same delta. Trip length and per-stop nights are preserved automatically — do NOT also emit change_nights when shifting dates.',
    '  newStartDate format: ISO date string YYYY-MM-DD. If the user gives a relative date ("two weeks later", "first weekend of September"), resolve it to an absolute YYYY-MM-DD against today (see the Today line in the trip context below) before emitting.',
    '  Avoid emitting a past newStartDate unless the user explicitly asks to backdate the trip (e.g. for completed-trip record-keeping). When in doubt, ask the user to confirm before emitting.',
    '  Do NOT use this action for changing the length of a single stop — use change_nights for that.',
    '',
    'EXAMPLE — correct assistant response when user says "Add Moab for one night after Flagstaff":',
    'Sure! I\'ll add Moab, UT for one night after Flagstaff.',
    '<modify>{"action":"add_stop","locationName":"Moab","locationState":"UT","type":"DESTINATION","nights":1,"afterStopOrder":2}</modify>',
    '',
    'EXAMPLE — correct assistant response when user says "Push the trip to start August 9th":',
    'Sure! I\'ll shift the whole trip so it starts August 9th. Your stop count and per-stop nights stay the same.',
    '<modify>{"action":"shift_trip_dates","newStartDate":"2026-08-09"}</modify>',
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

export async function chat(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { messages, tripId, sessionId, context, rigId, adHocVehicle } = req.body
    if (!messages || !Array.isArray(messages)) throw new AppError('Messages required', 400)

    // Daily cap for non-paying, non-trial accounts. Quiet cost protection.
    if (await enforceFreeAiCap(req, res)) return

    const userId = req.user!.id

    // Hard cap: cost protection. We never call Claude past this point.
    if (messages.length >= HARD_CAP) {
      console.warn(
        `[AI chat] Hard cap hit on session ${sessionId ?? '(none)'}, ` +
        `messages=${messages.length}, userId=${userId}`
      )
      return res.json({ message: HARD_CAP_RESPONSE, hardCapReached: true })
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

    // Annotate each <modify>{…}</modify> block in an assistant turn with the
    // literal marker "[✓ change already applied]", preserving surrounding
    // prose. Replaces the previous stripModifyTags helper that DELETED the
    // tags entirely — that turned every past assistant turn into a tagless
    // "successful" demonstration, and the model would gradually learn (via
    // in-context pattern-matching) that tags were optional, then stop
    // emitting them mid-conversation in long modify sessions. Annotating
    // instead lets the model see (a) it DID emit tags before in the right
    // format → keep emitting, and (b) the corresponding action is already
    // done → don't re-emit. Tagless prose turns are unaffected.
    const annotateAppliedModify = (content: string) =>
      content.replace(/<modify>[\s\S]*?<\/modify>/g, '[✓ change already applied]').trim()

    // Cap history at the last 10 messages before sending to Claude.
    const HISTORY_CAP = 10
    const nonSystemMessages = messages.filter((m: any) => m.role !== 'system')
    const systemMessages = messages.filter((m: any) => m.role === 'system')
    const cappedMessages = [
      ...systemMessages,
      ...nonSystemMessages.slice(-HISTORY_CAP),
    ]

    // Annotate <modify> tags in assistant history before sending to Claude.
    // System prompt (now first in combined prompt per Fix A) teaches the
    // format; assistant history demonstrates that the model DID emit tags
    // before AND that those actions are already applied — see the
    // annotateAppliedModify comment for the rationale on the
    // strip→annotate change.
    const cleanedMessages = cappedMessages.map((m: any) =>
      m.role === 'assistant' ? { ...m, content: annotateAppliedModify(m.content) } : m
    )

    const liveStateMsg = liveTrip ? buildLiveTripState(liveTrip) : null
    if (liveStateMsg) {
      console.log('[AI modify] context=modify tripId=%s stops=%d history=%d',
        tripId, liveTrip.stops?.length ?? 0, nonSystemMessages.length)
      console.log('[AI modify] ground-truth injected:\n', liveStateMsg)
    }
    // The wrap-up nudge is sent as a system message; chatWithAI prepends all
    // system messages to its base system prompt (see services/ai.ts).
    const softCapMsg = softCapHit ? [{ role: 'system' as const, content: SOFT_CAP_NUDGE }] : []
    const messagesForAI = liveStateMsg
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

    const aiCtx = { userId, sessionId: sessionId ?? null, tripId: tripId ?? null }
    let response = await chatWithAI(messagesForAI, userProfile, recentSurpriseDestinations, surpriseVibe, aiCtx)

    // Tracked across the retry path; surfaced to the client in the response
    // envelope so the UI can render a fallback notice when modify mode was
    // active, we attempted a retry, and the final response STILL has no
    // <modify> tag.
    let modifyTagMissing = false

    if (liveStateMsg) {
      const hasTag = /<modify>/.test(response)
      console.log('[AI modify] response hasModifyTag=%s preview=%s', hasTag, response.slice(0, 200))

      // Auto-retry whenever a modify-mode response lacks a <modify> tag,
      // regardless of whether the prose contains a hard-claim phrase. The
      // previous gate on MOD_CLAIM_RE (matching "I'll add" / "Done!" / "✅"
      // etc.) missed calm prose that should have included a tag — e.g.
      // "Sure, here's what I'd do…" would skip retry and silently no-op.
      // One retry only; if the second attempt also lacks a tag, set
      // modifyTagMissing so the UI surfaces the failure instead of
      // showing prose with no Apply affordance and no error.
      if (!hasTag) {
        console.warn('[AI modify] No <modify> tag detected in modification response — auto-retrying with reminder')
        const retryMessages = [
          ...messagesForAI,
          { role: 'assistant' as const, content: annotateAppliedModify(response) },
          {
            role: 'user' as const,
            content:
              '[SYSTEM REMINDER: Your previous reply did not include a <modify> JSON block, so NO change was applied. ' +
              'If the user\'s request requires a trip modification, repeat your response and include the correct <modify>{...}</modify> block now. ' +
              'If the request does NOT require a modification (just a question or discussion), reply normally without a tag.]',
          },
        ]
        const retryResponse = await chatWithAI(retryMessages, userProfile, recentSurpriseDestinations, surpriseVibe, aiCtx)
        const retryHasTag = /<modify>/.test(retryResponse)
        console.log('[AI modify] retry hasModifyTag=%s preview=%s', retryHasTag, retryResponse.slice(0, 200))
        if (retryHasTag) {
          response = retryResponse
        } else {
          // Retry also produced no tag. Could be a legitimate question/
          // discussion (no modification intended) or a genuine failure
          // (modification intended but not emitted). The server can't
          // disambiguate — let the UI render a fallback notice; the
          // user knows what they asked for and can rephrase if needed.
          modifyTagMissing = true
        }
      }
    }

    // Persist conversation to the appropriate field based on context.
    // 'modify' context → modifyConversation; all others → aiConversation.
    // Reuse liveTrip for modify (already fetched + ownership verified above).
    if (tripId) {
      const tripForPersist = liveTrip ?? await prisma.trip.findFirst({ where: { id: tripId, userId: req.user!.id } })
      if (tripForPersist) {
        const persistable = messages
          .filter((m: any) => m.role !== 'system')
          .map((m: any) => ({
            role: m.role,
            // Annotate <modify> tags in stored history so reloaded conversations
            // see consistent format AND the "already applied" marker — see the
            // annotateAppliedModify helper for the rationale on the
            // strip→annotate change.
            content: m.role === 'assistant' ? annotateAppliedModify(m.content) : m.content,
          }))
        // Same annotation for the new assistant response being persisted.
        persistable.push({ role: 'assistant', content: annotateAppliedModify(response) })

        await prisma.trip.update({
          where: { id: tripId },
          data: context === 'modify'
            ? { modifyConversation: persistable }
            : { aiConversation: persistable },
        })
      }
    }

    // modifyTagMissing surfaces to the client when modify mode was active,
    // we retried once, and the final response STILL lacked a <modify> tag.
    // For non-modify chats it stays false. The client (ModifyTripPanel)
    // renders an inline notice under the assistant bubble when set.
    res.json({ message: response, modifyTagMissing })
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
    res.json(trip.modifyConversation || [])
  } catch (err) { next(err) }
}

export async function generateItinerary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { messages } = req.body
    // Daily cap for non-paying, non-trial accounts. Quiet cost protection.
    if (await enforceFreeAiCap(req, res)) return
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
