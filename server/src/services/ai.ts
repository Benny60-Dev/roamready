import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../utils/prisma'

const apiKey = process.env.ANTHROPIC_API_KEY

if (!apiKey) {
  console.error('[AI] ANTHROPIC_API_KEY is not set — AI features will fail')
}

const client = new Anthropic({ apiKey })

// Anthropic pricing as of May 2026 — UPDATE WHEN PRICING CHANGES
// Source: https://www.anthropic.com/pricing
const PRICING = {
  'claude-sonnet-4-5':           { input: 3.00, output: 15.00 }, // per 1M tokens
  'claude-haiku-4-5':            { input: 1.00, output:  5.00 },
  'claude-haiku-4-5-20251001':   { input: 1.00, output:  5.00 },
} as const

type AICallType =
  | 'CHAT' | 'ITINERARY' | 'ROUTES' | 'ACTIVITIES'
  | 'PACKING' | 'HIGHLIGHTS' | 'FEEDBACK' | 'PLACES_LOOKUP'
  | 'PLANNING_SUMMARY'

export interface AICallCtx {
  userId: string
  sessionId?: string | null
  tripId?: string | null
}

export async function logAIUsage(params: {
  userId: string
  sessionId?: string | null
  tripId?: string | null
  callType: AICallType
  model: string
  inputTokens: number
  outputTokens: number
}) {
  try {
    const pricing = PRICING[params.model as keyof typeof PRICING]
    if (!pricing) {
      console.warn(`[AI usage] Unknown model for pricing: ${params.model}`)
      return
    }
    const costUsd =
      (params.inputTokens  / 1_000_000) * pricing.input +
      (params.outputTokens / 1_000_000) * pricing.output

    await prisma.aIUsageLog.create({
      data: {
        userId: params.userId,
        sessionId: params.sessionId ?? null,
        tripId: params.tripId ?? null,
        callType: params.callType,
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        estimatedCostUsd: costUsd,
      },
    })
  } catch (err) {
    // Fire-and-forget — never break a user's chat because logging failed.
    console.error('[AI usage] Log write failed:', err)
  }
}

export async function chatWithAI(
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  userProfile: any,
  recentSurpriseDestinations?: string[],
  surpriseVibe?: string,
  ctx?: AICallCtx,
) {
  // Explicit empty-home signal. userProfile is injected as JSON.stringify below,
  // and the controller sets homeCity/homeState/homeLocation to `undefined` when
  // the user has none — JSON.stringify DROPS undefined keys, so the model would
  // see no home keys at all and could not reliably tell "no home on file" from
  // "home omitted." It then defaults to the confident "use your home address in
  // [CITY]" template and invents a city. Surface the empty state as an explicit
  // directive instead of relying on the model to infer absence. When a home IS
  // on file, the profile JSON already carries it, so we add nothing (the
  // existing home-on-file behavior is unchanged).
  const hasHomeOnFile = !!(userProfile?.homeCity || userProfile?.homeLocation)
  const noHomeDirective = hasHomeOnFile
    ? ''
    : '\n\n⚠ NO HOME ADDRESS ON FILE — This user has no saved home city or address. When they have not named a starting city, you MUST ask "Where will you be starting from?" and wait for their answer before planning. Do NOT name, assume, invent, or borrow any starting city — not from these instructions\' examples, not from anywhere. If the user says "home", "my home", "from home", "use my home address", or any similar reference to home, do NOT treat that as a known location and do NOT invent or name a city. Tell them you don\'t have a home address on file and ask "Where will you be starting from?" before planning.'

  const systemPrompt = `You are RoamReady's AI trip planner. You ONLY help users plan outdoor trips — RV routes, van life journeys, car camping adventures, campground recommendations, OHV destinations, weather along routes, fuel costs, packing lists, and travel logistics.

If a user asks about ANYTHING unrelated to outdoor travel and trip planning — politics, relationships, medical advice, legal advice, other products, general knowledge questions, or any other off-topic subject — respond with exactly this: "I'm RoamReady's trip planning assistant and I can only help with outdoor travel planning. Is there a trip I can help you plan today?" Do not engage with off-topic questions under any circumstances. Do not be rude but be firm and redirect immediately back to trip planning. Stay focused on helping users plan amazing outdoor adventures.

You have access to the user's profile: ${JSON.stringify(userProfile)}${noHomeDirective}

Today is ${new Date().toISOString().slice(0, 10)}. Use this to resolve any departure date the user gives to the correct calendar year (see the DEPARTURE DATE RULE below).

Trip planning rules:
- Never ask for information already in their profile (rig size, pets, budget, home base, memberships, accessibility needs)
- Ask only what you need: destination, dates, and must-see stops
- DEPARTURE DATE RULE — capture a concrete departure date and emit it as the itinerary's top-level "startDate" (ISO "yyyy-mm-dd"). Use today's date (given above) to resolve the correct YEAR — if the stated month has already passed this year, use next year. Three cases:
  - SPECIFIC date ("leave September 15", "departing 9/15", "the 15th of Sept") → resolve it to "yyyy-mm-dd" in the correct year and put it in startDate. Build normally.
  - VAGUE month or season with NO specific day ("September", "this fall", "sometime in spring") → do NOT pick silently and do NOT emit an itinerary yet. Propose the FIRST TUESDAY of that month and ask the user to confirm, in exactly one short turn with NO <itinerary> block — e.g. "For September, I'd suggest leaving Tuesday the 1st — midweek is the sweet spot for RV travel (lighter weekend traffic, easier campground availability). Want me to plan around that, or do you have a specific date in mind?" Then WAIT. Only once the user confirms (or gives their own date) do you emit the itinerary, with startDate set to the agreed date. (This mirrors the surprise-rule STEP 1 pattern: ask one thing, emit nothing else — so the trip does not build until the date is settled.)
  - NO date mentioned at all → omit startDate entirely (or set it null). Do not invent one and do not block the build on it.
- Maximum 3 questions before building the itinerary. EXEMPTION: the one-time surprise length/range question described in the Surprise trip rule below does NOT count toward this limit — it applies ONLY when the user has deferred the destination to you ("surprise me", "you pick", etc.). For normal trips where the user named a destination, the 3-question limit applies in full — do not use this exemption to ask extra questions on a named-destination trip.
- Surprise trip rule:
  PRECEDENCE — This rule applies ONLY when the user has NOT named a destination. If the message contains an explicit destination (including any "from X to Y", "trip to Y", or "going to Y" pattern — e.g. "Create me a trip from [Origin] to [Destination]"), this rule does NOT apply AT ALL: do NOT ask the scope/length question, do NOT use the surprise opener, do NOT treat it as a deferral. Route directly to the NAMED DESTINATION RULE below and plan the trip. A named destination hard-disqualifies the surprise branch even if the message also sounds open-ended.
  This applies when the user defers the destination choice to you — "surprise me", "you pick", "choose somewhere", "pick a destination", or any message indicating they want YOU to select where to go.
  STEP 1 — ask ONE question first (unless already answered): If the user has NOT yet told you roughly how long the trip is and whether they want to stay regional or go far, your FIRST response must be exactly one enthusiastic question and nothing else (do NOT pick a destination yet, do NOT emit an itinerary). Use this scripted line: "Ooh, a surprise trip — love it! Two quick things so I nail it: roughly how long are you thinking (a weekend, about a week, or a big open-ended adventure), and do you want to stay regional or are you up for going farther afield?" Then wait for their answer. If the user ALREADY stated a length/range earlier in the conversation, skip this question and pick directly — never re-ask what they already told you.
  STEP 2 — pick within that frame, scaling distance by length:
    • Weekend / a few nights → choose a REGIONAL destination within a comfortable drive.
    • About a week → moderate range; a few states away is great.
    • Long / open-ended / "big adventure" → range WIDELY across the country. Pick somewhere genuinely novel and worth the distance; do NOT default to the nearest easy option. The long total distance is fine — just insert OVERNIGHT_ONLY transit stops so each individual leg stays within the user's maxDriveHours (the per-leg hard limit), exactly as you would for any long trip.
    Across ALL lengths: favor VARIETY and novelty — somewhere the user likely would not have picked themselves. Honor the recent-picks exclusion and the vibe hint when they appear in the CRITICAL RULES block above. Still respect the hard constraints (rig compatibility, pets, accessibility, towing route hazards, per-leg maxDriveHours).
  STEP 3 — propose ONE specific destination, never a list of options. State it confidently in your opening line, explain in 2–3 sentences why it fits them and the length/range they gave, then proceed directly to building the itinerary (emit the <itinerary> block) without asking for further confirmation. End your message with a low-risk reroll offer, e.g. "Want me to spin up a totally different vibe instead?"
- NAMED DESTINATION RULE: When the user names a specific destination, use that exact destination as the trip's endpoint. You MAY suggest an alternative if you believe it is a genuinely better fit (e.g. closer, more RV-friendly, better matched to their rig size or pets), but you MUST: (a) treat the user's named destination as the default plan, (b) state your suggested alternative clearly and explain why it might be better, and (c) only switch to the alternative if the user explicitly agrees. NEVER silently replace a destination the user named. This rule does not apply when the user has delegated the destination choice to you ("surprise me", "you pick", etc.) — in that case, choose freely per the Surprise trip rule above.
- When you have enough information, respond with a JSON itinerary block inside <itinerary> tags — after the JSON block, do NOT add any closing message asking the user to click a button, build the itinerary, or take any UI action; the interface detects the itinerary automatically and shows the build button on its own
- Stop "type" must be exactly one of: DESTINATION, OVERNIGHT_ONLY, HOME — never use TRAVEL or any other value
- Always include the trip starting location as the first stop in the itinerary with type HOME and order 1. This is the departure point and should always be the first entry in the stops array regardless of whether the user mentioned it explicitly. Use the starting location confirmed during the conversation as this stop's locationName and locationState — if the user said they are leaving from home or did not specify a starting city, use homeCity and homeState from their profile if present, otherwise extract the city from homeLocation; if there is NO home on file at all (no homeCity and no homeLocation), do NOT invent or assume a starting city — ask the user where they are starting from (per the starting-location rules above) and use only the city they provide; if the user explicitly specified a different starting city (e.g. "I'm leaving from [Origin]"), use that city and state instead. Set nights to 0 for the HOME stop.
- The FIRST stop (order: 1) must always be HOME type — NEVER DESTINATION or OVERNIGHT_ONLY
- The LAST stop must always be DESTINATION — NEVER OVERNIGHT_ONLY or HOME
- OVERNIGHT_ONLY is exclusively for mid-route transit stops where the traveler is simply sleeping before continuing the next morning — it is never the trip origin or final destination
- DRIVE-TIME CONSTRAINT — HARD RULE: The user has a max daily drive time set in their travelProfile (\`maxDriveHours\`, in hours). Treat this as a HARD upper bound on each leg between consecutive stops, NOT an average across the trip.
  Conversion: at typical RV highway speeds (~55 mph), 1 hour ≈ 55 miles. Add ~30% slack for non-highway routing and stops. So 6 hours ≈ ~330 miles per leg, 8 hours ≈ ~440 miles per leg.
  If a planned leg between two consecutive stops would exceed the user's limit, you MUST insert one or more OVERNIGHT_ONLY stops to break the leg up. For each transit stop you propose, you MUST estimate the distance from the previous stop and confirm it falls within the limit (with the ~30% slack noted above). Distance from the destination is irrelevant — only distance from the previous stop. If the most well-known transit city for the route is too far from the previous stop, pick a closer city instead, even if that means adding an extra overnight stop. It is better to insert two short transit days than one too-long day. When in doubt, err on the side of MORE transit stops, not fewer.
  Fallback values when fields are null:
    - If \`maxDriveHours\` is null but \`maxMilesPerDay\` is set, use \`maxMilesPerDay\` directly as the per-leg limit.
    - If both are null, default to 350 miles per leg.
  Override conditions: if the user explicitly says in this conversation that they want to drive straight through, do a long day, or skip overnight stops, that overrides this rule for that trip only. Otherwise, NEVER emit a leg you believe will exceed the limit.
  This applies to BOTH initial trip generation and to <modify> actions: if removing a stop would create an over-long leg, propose inserting a transit stop instead, or warn the user before emitting the modify.
- TRAVEL PARTY — HARD RULE: The user's \`defaultParty\` (or this trip's \`party\`, if set — trip-level overrides user-level) describes who is traveling. You MUST consult party data when making recommendations. Treat the trip-scoped party as authoritative when it exists; otherwise use defaultParty.
  PEOPLE
  - For each Person with isTraveling=true: count them in the party size. Use this for campground capacity ("sleeps N"), site recommendations, and activity suggestions.
  - Persons with isTraveling=false (typically with isEmergencyContact=true) are NOT on the trip — never count them in party size or include them in trip-context narration.
  - If any Person has accessibilityNeeds set (a JSON object with flags like wheelchair, paved_path, accessible_restroom, near_facility, level_site, low_elevation), filter campground recommendations to ADA/accessible sites and avoid steep or rough-terrain stops. When you recommend or filter sites based on accessibility needs, add a brief note telling the user to confirm specific accessibility/ADA details directly with the campground, since reported accessibility data can be incomplete or out of date.
  - If any Person has dietaryNotes (e.g. "gluten-free", "kosher"), prefer stops near grocery stores or restaurants that can accommodate.
  - If any Person has role=CHILD or INFANT, prefer family-friendly campgrounds, suggest age-appropriate activities, and avoid adult-only RV resorts.
  - militaryStatus and firstResponder on a Person are informational; do NOT use them to gate suggestions (the campground access endpoint handles that separately at the account-holder level).
  PETS
  - If pets array is non-empty: ONLY suggest pet-friendly campgrounds. Mention that you've filtered for pet-friendly options.
  - Pet weightLbs > 50: avoid campgrounds that have small-dog-only or weight-limit policies; mention "large-dog-friendly" explicitly when relevant.
  - leashTrained=false on any pet: prefer campgrounds with fenced sites or dog runs; avoid sites that strictly require leashing.
  - comfortableInCrowds=false on any pet: avoid busy resorts, prefer quieter / state-park-style campgrounds.
  - comfortableAtNight=false on any pet: prefer sites with low ambient noise, not near generators or main roads.
  - Pet \`notes\` (free-form) may contain medical or behavioral info — read it, factor it in, but DO NOT regurgitate sensitive info back to the user unless they bring it up first.
  EMERGENCY CONTACTS
  - Persons with isEmergencyContact=true are stored for emergencies. Do NOT include them in trip planning suggestions or party-size counts.
  FALLBACK BEHAVIOR
  - If defaultParty (and trip.party) is null AND the legacy travelProfile fields (\`adults\`, \`children\`, \`hasPets\`) are populated, fall back to those for party size and pet status. This is the transition state until Phase C removes the legacy fields.
  - If both party and legacy fields are null/zero, ask the user "who's coming on this trip?" before generating an itinerary.
  NEVER LEAK SCHEMA — when narrating to the user, say "your dog" or "your two adults and a kid", not "your party has 1 pet of type DOG with leashTrained=true." The schema fields are inputs to your reasoning; the output is plain conversational English.
- TOWING CONTEXT — when the user is towing or driving a towed RV, factor the combined rig+tow into route, fuel, and campground choices:
  - Trigger: rig.isTowing=true (a Class A/B/C motorhome flat-towing a vehicle or pulling a trailer) OR rig.vehicleType in (FIFTH_WHEEL, TRAVEL_TRAILER) (the rig itself is towed by a truck). Both warrant the same caution. towedType=VEHICLE means a flat-towed car/Jeep/truck behind a motorhome ("toad"); towedType=TRAILER means a utility/cargo trailer behind a motorhome.
  - Avoid recommending routes with sharp switchbacks, narrow mountain passes, or steep grades known to be problematic for long combined lengths. Concrete examples to AVOID when towing: CA-1 around Big Sur, the Tail of the Dragon (US-129 in NC/TN), Going-to-the-Sun Road in Glacier NP, and any road with posted vehicle-length restrictions. If a tempting destination would otherwise require one of these roads, suggest an alternative route or a different access point.
  - Prefer truck stops (Pilot, Flying J, Love's, TA, Petro) over standard gas stations for fuel suggestions — combined rig+tow can't easily back out of normal pump islands. This applies to BOTH the motorhome+toad case and the truck-pulling-fifth-wheel case.
  - Prefer pull-through campsites over back-in sites when recommending campgrounds. If only back-in is available, that's still fine — note it in the recommendation so the user is prepared.
  - Expect ~15-25% lower fuel mileage when towing or driving a towed RV, on top of the rig's base mpg from their profile. Factor this into how often you suggest fuel stops, especially across long uninhabited stretches (parts of NV, UT, WY).
  - Do NOT add transit stops solely because of towing. The maxDriveHours rule still governs daily driving distance regardless of tow status.
  - Do NOT mention rig.licensePlate or rig.towedLicensePlate in itinerary descriptions or campground recommendations — those are private user data, surfaced separately at check-in time only.
- ROUND TRIP / RETURN HOME RULE — NEVER add a return-home stop unless the user EXPLICITLY uses one of these exact phrases: "round trip", "round-trip", "coming back home", "returning home", "back home", "end at home", "back to [home city]", "heading home after". If the user provides a destination and dates without any of those phrases, the trip is ONE-WAY — do NOT add a return stop. Example of correct one-way behavior: "Plan a one-way trip from [HomeCity] to Del Rio, leaving May 15, 3 nights" → stops: HOME([HomeCity]), any transit stops, DESTINATION(Del Rio). NO [HomeCity] return stop. Example of correct round-trip behavior: "leaving [HomeCity], going to Flagstaff for 2 nights, then coming back home" → stops: HOME([HomeCity]), DESTINATION(Flagstaff, 2 nights), DESTINATION([HomeCity], 0 nights). Dates alone ("leaving May 15, arriving around May 18") do NOT imply round-trip. The phrase "arriving at destination" does NOT imply returning home. One-way is the default — round-trip requires an explicit request.
- USER VOCABULARY — how to talk about stops in plain English (separate from the data model):
  - The HOME entry (data: order 1, type HOME) is the user's "starting point" or "departure" — NEVER call it "stop 1" or "the first stop" when speaking to the user
  - On round-trip / loop trips, the closing return-home entry (data: last stop, type DESTINATION but at the home city, nights 0) is "the trip ends" / "back home" / "your return home" — NEVER call it "the last stop" or "stop N"
  - When numbering destinations for the user, count starts at 1 with the FIRST destination AFTER the home departure. Example: a trip with HOME([HomeCity]) → Williams → Sedona → return [HomeCity] is, in user-facing language, "starting from [HomeCity], then Stop 1: Williams, Stop 2: Sedona, then back home." There is NO Stop 0, and [HomeCity] is NEVER "Stop 1" in conversation.
  - When the user says "the first stop" / "stop 1" / "remove stop 2" / "the last stop", they almost always mean a numbered destination — NOT the home departure or the return-home entry. If the request is ambiguous (e.g. "remove the first stop" on a trip whose HOME departure is also at the user's primary city), ASK BEFORE MODIFYING: "Just to confirm — do you mean [first destination after departure], or did you mean to change your starting point?" Wait for the user's answer before emitting any <modify> tag.
  - Internal data references ARE STILL 1-INDEXED with HOME at order 1: <itinerary> JSON, <modify> action's afterStopOrder field, and any other structured output keep using the data model's ordering. Only the user-facing prose vocabulary changes — never tell the user "I'll remove stop 1" while internally meaning the home stop. Translate first, then act.
- Points of interest and drive-through stops: pointsOfInterest on a stop must contain ONLY stops, attractions, or photo ops that the user explicitly named in this conversation (e.g. "stop at Prada Marfa on the way", "drive through Marfa", "we want to see the Marfa Lights"). When the user names a POI, do NOT add it as a separate Stop in the stops array — instead, note it in your conversational response AND add the POI as {"name": "...", "durationMinutes": N} to the pointsOfInterest array of the nearest stop the user is driving toward on that leg. Estimate durationMinutes from context: quick photo stop → 15, short visit → 30, meal or longer stop → 60, half-day attraction → 120; default to 30 if unspecified. Every user-requested POI must appear in exactly one stop's pointsOfInterest array. NEVER populate pointsOfInterest with AI-generated attraction suggestions, destination highlights, or anything the user did not explicitly request — not even for surprise trips or trips where the user gave no specific POI requests. If the user named no POIs, every stop's pointsOfInterest must be omitted entirely or set to [].
- Always consider rig compatibility — never suggest campgrounds incompatible with their rig
- For toy haulers, prioritize OHV destinations matching their terrain preferences
- For vans, prioritize BLM/dispersed/Harvest Hosts over hookup campgrounds
- For car campers, include tent-only, walk-in, and backcountry sites
- Apply military campground options only if user has military/first responder status
- Apply membership discounts automatically
- Starting location confirmation rules (must happen before any other trip questions):
  - PRECEDENCE — scan the user's message for a named starting city BEFORE checking for home-departure language. If the user has named a specific starting city in their message (e.g. "from [Origin]", "leaving [Origin]", "trip starting in [Origin]", "from [Origin], [State] to [Destination]"), that city is ALWAYS the origin — even if it differs from their home city in the profile. Do NOT assume the user is departing from home just because a home address exists in their profile. The home address is a fallback, not a default.
  - If the user names a specific starting city, confirm it back as the very first response before asking anything else: "Got it — starting from [City, State]. Where are we headed?"
  - NO HOME ON FILE — if the user names no starting location AND there is no homeCity AND no homeLocation in their profile, you MUST NOT assume, invent, or name any city, and you MUST NOT borrow a city from the examples in these instructions. Ask, in our voice, exactly: "Where will you be starting from?" — then wait for their answer before asking anything else or building anything. Never claim to "use your home address" when no home is on file.
  - HOME ON FILE — ONLY when a real homeCity or homeLocation actually exists in the profile: if the user explicitly says "home", "leaving from home", "starting from home", "from home", or a similar phrase that directly references their home as the departure point — OR if the user mentions no starting location at all — respond with exactly this format: "Perfect — I'll use your home address in [CITY] as the starting point. Now where are we headed?" — replacing [CITY] with only the city name from their profile (prefer homeCity if present, otherwise extract the city portion from homeLocation). Never include a street address, zip code, or any other address detail — city name only. If no home is on file, do NOT use this line and do NOT fill in any city: instead tell the user you don't have a home address on file and ask "Where will you be starting from?"
  - Always confirm the starting location as the very first response before asking any other questions about the trip.
- Be warm, knowledgeable, and conversational — like a well-traveled friend
- Campground candidates: For every stop with nights > 0 (so EXCLUDING the HOME stop and any 0-night final-destination return), include a "campgroundCandidates" array of 3-4 plausible REAL campground names near that stop. Examples: "Polson/Flathead Lake KOA", "Westwood RV Park", "Big Arm State Park". Names ONLY — do NOT include addresses, phone numbers, websites, or descriptions. Order by your best guess of fit/quality (top of list = most likely match for this user's rig and travel style). These names will be verified against Google Places before being shown to the user, so accuracy matters more than creativity. For HOME stops and 0-night stops, omit campgroundCandidates entirely or set it to []. Keep the existing campgroundName field as null on each stop — campgroundName is reserved for the user's actual booked choice and is set later, not by you.

⚠ ONE-WAY IS THE UNCONDITIONAL DEFAULT ⚠

The final stop in your JSON MUST be the user's DESTINATION — NEVER the home city — unless the user explicitly used one of these round-trip phrases: "round trip", "round-trip", "coming back home", "returning home", "back home", "end at home", "back to [home city]", "heading home after".

Do NOT append a stop that returns to the home city for a one-way request. A trip to Denver ends in Denver. A trip to Moab ends in Moab. A "you pick" surprise trip ends at whatever destination you chose. When none of the round-trip phrases above appear in the conversation, build a one-way trip — full stop.

Itinerary JSON format — ONE-WAY ([HomeCity] → Albuquerque, with one OVERNIGHT_ONLY transit stop because the direct drive exceeds maxDriveHours):
{
  "name": "Trip name",
  "startDate": "2026-09-15",
  "totalMiles": 0,
  "totalNights": 0,
  "estimatedFuel": 0,
  "estimatedCamp": 0,
  "stops": [
    {
      "order": 1,
      "type": "HOME",
      "locationName": "[HomeCity]",
      "locationState": "[HomeState]",
      "nights": 0,
      "campgroundName": null,
      "campgroundCandidates": [],
      "siteRate": 0,
      "estimatedFuel": 0,
      "hookupType": "",
      "isPetFriendly": true,
      "isMilitaryOnly": false
    },
    {
      "order": 2,
      "type": "OVERNIGHT_ONLY",
      "locationName": "Lubbock",
      "locationState": "TX",
      "nights": 1,
      "campgroundName": null,
      "campgroundCandidates": ["Lubbock KOA", "Loop 289 RV Park", "Buffalo Springs Lake RV Park"],
      "siteRate": 45,
      "estimatedFuel": 0,
      "hookupType": "full",
      "isPetFriendly": true,
      "isMilitaryOnly": false
    },
    {
      "order": 3,
      "type": "DESTINATION",
      "locationName": "Albuquerque",
      "locationState": "NM",
      "nights": 3,
      "campgroundName": null,
      "campgroundCandidates": ["Albuquerque North Bernalillo KOA", "Enchanted Trails RV Park", "Isleta Lakes & RV Park"],
      "siteRate": 55,
      "estimatedFuel": 0,
      "hookupType": "full",
      "isPetFriendly": true,
      "isMilitaryOnly": false
    }
  ]
}

The example above has 3 stops: HOME → OVERNIGHT_ONLY(transit) → DESTINATION. There is NO return stop. This is the correct shape for the default one-way case. Omit the transit stop for trips where the direct drive fits within maxDriveHours.

ROUND TRIP — text description only, no separate JSON template:
If and only if the user explicitly used one of the round-trip trigger phrases above, append a final DESTINATION stop at the home city (nights: 0) after the last destination. Use the same JSON fields as any other stop. On the return leg, insert OVERNIGHT_ONLY transit stops whenever the destination→home distance exceeds maxDriveHours, just as you would on the outbound. For short round trips where the full one-way distance fits within maxDriveHours, go HOME → DESTINATION → HOME(nights:0) directly with no transit stops.

Always match transit stops to actual driving distance — add them when a leg would exceed the daily limit, omit them when it fits. Never add or omit transit stops mechanically.`

  // Filter out any role:'system' messages before sending to Anthropic.
  // The Messages API only accepts 'user' and 'assistant' roles in the messages array;
  // system context must be passed as the top-level system parameter.
  const systemMessages = messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : '').join('\n')
  const cleanMessages = messages.filter(m => m.role !== 'system') as Array<{ role: 'user' | 'assistant'; content: string }>
  // Fix A: In modify mode (systemMessages present), put modify instructions FIRST so Claude
  // anchors on the <modify> tag requirement before reading the base planner rules.
  // Surprise-trip critical rules (exclusion + vibe), when present, prepend the entire
  // prompt so Claude anchors on them before any other instruction.
  const criticalRulesParts: string[] = []

  if (recentSurpriseDestinations && recentSurpriseDestinations.length > 0) {
    criticalRulesParts.push(
      `HARD RULE — must obey: This user was recently sent to: ${recentSurpriseDestinations.join(', ')}. Your destination MUST NOT be any of these places, AND MUST be at least 150 miles away from each one. Do not propose attractions, day trips, or campgrounds within 150 miles of any excluded place — this includes anything that would 'base out of' or 'use as a hub' those cities. This rule overrides convenience and familiarity preferences. If your first instinct is one of the excluded places, deliberately pick something different — a different region of the country if necessary. The DRIVE-TIME CONSTRAINT still applies — if a surprise destination would require a leg longer than the user's limit, you MUST insert OVERNIGHT_ONLY transit stops along the way, just as you would for any other trip.`
    )
  }

  if (surpriseVibe) {
    criticalRulesParts.push(
      `For variety on this surprise trip, lean toward ${surpriseVibe} — but only if it genuinely fits the user's rig, season, and reasonable driving distance. If it doesn't fit, pick something else that does fit and still feels different from their recent picks.`
    )
  }

  const criticalRulesBlock = criticalRulesParts.length > 0
    ? `## CRITICAL RULES FOR THIS REQUEST\n\n${criticalRulesParts.join('\n\n')}\n\n---\n\n`
    : ''

  const combinedSystem = criticalRulesBlock + (
    systemMessages
      ? systemMessages + '\n\n' + systemPrompt
      : systemPrompt
  )

  const model = 'claude-sonnet-4-5'
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: combinedSystem,
    messages: cleanMessages,
  })

  if (ctx?.userId) {
    logAIUsage({
      userId: ctx.userId,
      sessionId: ctx.sessionId ?? null,
      tripId: ctx.tripId ?? null,
      callType: 'CHAT',
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }).catch(() => {})
  }

  return response.content[0].type === 'text' ? response.content[0].text : ''
}

export async function generatePackingListAI(trip: any, user: any, ctx?: AICallCtx): Promise<any[]> {
  const rig = user?.rigs?.[0]
  const profile = user?.travelProfile

  // Travel Party (Phase A): trip-scoped party > user.defaultParty > legacy fields.
  // For packing-list purposes we need counts (people / kids / pets) and any
  // dietary or accessibility flags that affect what to bring.
  const tripParty = trip?.party ?? null
  const defaultParty = user?.parties?.[0] ?? null
  const party = tripParty ?? defaultParty
  const travelingPeople = (party?.people ?? []).filter((p: any) => p.isTraveling)
  const partySummary = party
    ? {
        adults: travelingPeople.filter((p: any) => p.role === 'ADULT' || p.role === 'TEEN').length,
        children: travelingPeople.filter((p: any) => p.role === 'CHILD' || p.role === 'INFANT').length,
        accessibilityNeeds: travelingPeople.map((p: any) => p.accessibilityNeeds).filter(Boolean),
        dietaryNotes: travelingPeople.map((p: any) => p.dietaryNotes).filter(Boolean),
        pets: (party.pets ?? []).map((pet: any) => ({
          type: pet.type,
          breed: pet.breed,
          weightLbs: pet.weightLbs,
          notes: pet.notes,
        })),
      }
    : null

  const prompt = `Generate a comprehensive packing list for this trip:

Trip: ${trip.name}
Nights: ${trip.totalNights || trip.stops?.reduce((sum: number, s: any) => sum + (s.nights || 1), 0) || 'Unknown'}
Vehicle: ${rig?.vehicleType || 'Unknown'}
Hookup preference: ${profile?.hookupPreference || 'Unknown'}
${partySummary
  ? `Travel party: ${JSON.stringify(partySummary)}`
  : `Adults: ${profile?.adults || 1}, Children: ${profile?.children || 0}\nHas pets: ${profile?.hasPets || false}\nPet details: ${JSON.stringify(profile?.petDetails || {})}  (party not set — using legacy fields)`}
Interests: ${JSON.stringify(profile?.interests || [])}
Toy hauler: ${rig?.isToyHauler || false}
Toys: ${JSON.stringify(rig?.toys || [])}

Travel party rules — when generating the packing list:
- Quantity-sensitive items (towels, plates, sleeping bags) scale with traveling people count, NOT including emergency contacts.
- For each Person with dietaryNotes, include relevant kitchen / pantry items (gluten-free pasta, kosher snacks, etc.).
- For each Person with accessibilityNeeds (wheelchair, mobility, etc.), include relevant gear (transfer board, portable ramp, shower chair if applicable). When you include gear based on accessibility needs, add a brief note telling the user to confirm specific accessibility/ADA details directly with the campground, since reported accessibility data can be incomplete or out of date.
- For each pet, include species-appropriate items (food bowl, leash for dogs, litter for cats); scale food quantity by weightLbs and trip nights; if leashTrained=false add "long line / tie-out cable" and "portable fence panels"; if comfortableInCrowds=false add "calming aids / familiar bedding".
- Output category and item names in plain English. Never use schema field names ("leashTrained=false") in item names.

Return a JSON array of categories with items. Format:
[
  {
    "category": "Category Name",
    "items": [
      { "name": "Item name", "required": true/false, "checked": false }
    ]
  }
]`

  const model = 'claude-sonnet-4-5'
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  if (ctx?.userId) {
    logAIUsage({
      userId: ctx.userId,
      sessionId: ctx.sessionId ?? null,
      tripId: ctx.tripId ?? trip?.id ?? null,
      callType: 'PACKING',
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }).catch(() => {})
  }

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : []
  } catch {
    return []
  }
}

export async function generateTripItineraryAI(trip: any, user: any, ctx?: AICallCtx): Promise<any[]> {
  const rig = user?.rigs?.[0]
  const profile = user?.travelProfile
  const stops = (trip.stops || []).sort((a: any, b: any) => a.order - b.order)

  // Travel Party (Phase A): trip-scoped party overrides user's defaultParty,
  // both override legacy TravelProfile fields. Compose a compact party summary
  // for the day-by-day itinerary prompt — itineraries should reflect who is
  // actually on the trip (kids, accessibility needs, pet behavior).
  const tripParty = trip?.party ?? null
  const defaultParty = (user?.parties?.[0] ?? null)
  const party = tripParty ?? defaultParty
  const travelingPeople = (party?.people ?? []).filter((p: any) => p.isTraveling)
  const partySummary = party
    ? {
        peopleCount: travelingPeople.length,
        roles: travelingPeople.map((p: any) => p.role),
        hasKids: travelingPeople.some((p: any) => p.role === 'CHILD' || p.role === 'INFANT'),
        accessibilityNeeds: travelingPeople
          .map((p: any) => p.accessibilityNeeds)
          .filter(Boolean),
        dietaryNotes: travelingPeople.map((p: any) => p.dietaryNotes).filter(Boolean),
        petCount: (party.pets ?? []).length,
        pets: (party.pets ?? []).map((pet: any) => ({
          type: pet.type,
          weightLbs: pet.weightLbs,
          leashTrained: pet.leashTrained,
          comfortableInCrowds: pet.comfortableInCrowds,
          comfortableAtNight: pet.comfortableAtNight,
        })),
      }
    : null

  const stopSummaries = stops.map((s: any, i: number) => ({
    order: i + 1,
    type: s.type,
    location: `${s.locationName}${s.locationState ? ', ' + s.locationState : ''}`,
    nights: s.nights || 1,
    campground: s.campgroundName || null,
    arrivalDate: s.arrivalDate || null,
    departureDate: s.departureDate || null,
    lat: s.latitude,
    lng: s.longitude,
    pointsOfInterest: s.pointsOfInterest?.length ? (s.pointsOfInterest as any[]).map((p: any) => p.name) : [],
  }))

  const prompt = `Generate a detailed day-by-day itinerary for this RV/camping trip. You must return ONLY valid JSON — no prose, no markdown, no code fences.

Trip: ${trip.name}
Total miles: ${trip.totalMiles || 'unknown'}
Vehicle: ${rig?.vehicleType || 'RV'}
Interests: ${JSON.stringify(profile?.interests || [])}
Toy hauler: ${rig?.isToyHauler || false}
${partySummary
  ? `Travel party: ${JSON.stringify(partySummary)}`
  : `Has pets: ${profile?.hasPets || false}  (party not set — using legacy fields)`}

Travel party rules — when generating activities, route descriptions, and transit notes:
- Reflect the people actually traveling (peopleCount, roles, hasKids). Family-friendly tone for trips with kids; quieter / less-crowded suggestions when accessibility needs are present.
- When the party has accessibilityNeeds (flags like wheelchair, paved_path, accessible_restroom, near_facility, level_site, low_elevation), prioritize accessible (ADA) campgrounds and sites, prefer level/paved options, and avoid steep or rough-terrain stops and strenuous activities.
- For drive-day descriptions: consider pet behavior (e.g. comfortableAtNight=false → mention quiet overnight stops; leashTrained=false → suggest fenced rest areas).
- Output narration in plain English ("your two adults and a kid", "your dog") — never schema field names ("leashTrained=false", "type=DOG").

Stops (in order):
${JSON.stringify(stopSummaries, null, 2)}

Rules:
- Return a JSON array of day entries (one per day of the trip)
- For each DRIVE day between two stops, include: highwayRoute (major highway route string such as "US-60 East → I-17 North → US-89 North" — official highway designations with cardinal directions, 2-5 highways in travel order separated by →, no city names), routeDescription (2-3 sentences about the drive, highways, scenery), terrainSummary (1 sentence). Do NOT include a pointsOfInterest field on DRIVE days — omit it entirely or set it to null.
- For DESTINATION/HOME arrival day: routeDescription is optional (short "arriving at X" note)
- For each ACTIVITY day (nights 2+ at a destination): provide activities array with 3-5 suggested activities as strings tailored to the location and user interests
- For OVERNIGHT_ONLY stops: provide a brief transitNote (1 sentence about the overnight location)
- Day numbering starts at 1
- Make descriptions vivid, practical, and specific to the actual route and locations

Return this exact JSON structure (array of objects):
[
  {
    "dayNum": 1,
    "type": "DRIVE",
    "stopOrder": 2,
    "highwayRoute": "US-60 East → I-17 North → US-89 North",
    "routeDescription": "...",
    "terrainSummary": "...",
    "pointsOfInterest": [{"name": "Location", "durationMinutes": 30}],
    "activities": null,
    "transitNote": null
  },
  {
    "dayNum": 2,
    "type": "STAY",
    "stopOrder": 2,
    "routeDescription": null,
    "terrainSummary": null,
    "pointsOfInterest": null,
    "activities": null,
    "transitNote": null
  },
  {
    "dayNum": 3,
    "type": "ACTIVITY",
    "stopOrder": 2,
    "routeDescription": null,
    "terrainSummary": null,
    "pointsOfInterest": null,
    "activities": ["Hike the main trail", "Visit the visitor center"],
    "transitNote": null
  }
]`

  const model = 'claude-sonnet-4-5'
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  if (ctx?.userId) {
    logAIUsage({
      userId: ctx.userId,
      sessionId: ctx.sessionId ?? null,
      tripId: ctx.tripId ?? trip?.id ?? null,
      callType: 'ITINERARY',
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }).catch(() => {})
  }

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    const parsed: any[] = jsonMatch ? JSON.parse(jsonMatch[0]) : []

    // Replace AI's pointsOfInterest on DRIVE days with only user-requested POIs from the
    // destination stop. AI-generated suggestions are excluded entirely.
    const merged = parsed.map((day: any) => {
      if (day.type !== 'DRIVE') return day
      const stop = stops.find((s: any) => s.order === day.stopOrder)
      const stopPOIs: any[] = (stop?.pointsOfInterest as any[]) ?? []
      return { ...day, pointsOfInterest: stopPOIs.length ? stopPOIs : null }
    })
    console.log('[generateTripItineraryAI] final DRIVE day POIs:', merged.filter((d: any) => d.type === 'DRIVE').map((d: any) => ({ dayNum: d.dayNum, pointsOfInterest: d.pointsOfInterest })))
    return merged
  } catch {
    console.error('[generateTripItineraryAI] JSON parse failed, text:', text.slice(0, 200))
    return []
  }
}

export async function generateRouteStringsAI(trip: any, ctx?: AICallCtx): Promise<{ segmentIdx: number; route: string }[]> {
  const stops = (trip.stops || []).sort((a: any, b: any) => a.order - b.order)

  // Build the list of drive segments (consecutive stop pairs)
  const segments: string[] = []
  for (let i = 1; i < stops.length; i++) {
    const from = `${stops[i - 1].locationName}${stops[i - 1].locationState ? ', ' + stops[i - 1].locationState : ''}`
    const to   = `${stops[i].locationName}${stops[i].locationState ? ', ' + stops[i].locationState : ''}`
    segments.push(`${i - 1}. ${from} → ${to}`)
  }

  if (segments.length === 0) return []

  const prompt = `For each drive segment below, list every major highway, interstate, and state route in travel order for an RV trip. Return ONLY valid JSON — no prose, no markdown.

Segments:
${segments.join('\n')}

Return this exact JSON array — one entry per segment:
[
  { "segmentIdx": 0, "route": "I-10 East → SR-202 East → I-17 North → US-89 North" },
  { "segmentIdx": 1, "route": "US-89 North → US-160 East → US-163 North" }
]

Rules:
- List every major highway, interstate, and state route in order — include every significant road change, do not skip any major highways
- Use official designations only: I-40, US-89, SR-202, AZ-89, CO-128, etc.
- Include cardinal direction after each highway: North, South, East, or West
- List in travel order, separated by →
- No city names, exits, mile markers, or narrative — highway numbers and directions only`

  const model = 'claude-sonnet-4-5'
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  if (ctx?.userId) {
    logAIUsage({
      userId: ctx.userId,
      sessionId: ctx.sessionId ?? null,
      tripId: ctx.tripId ?? trip?.id ?? null,
      callType: 'ROUTES',
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }).catch(() => {})
  }

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : []
  } catch {
    return []
  }
}

export async function generateStopActivitiesAI(
  stops: Array<{ stopIdx: number; locationName: string; locationState?: string; nights: number }>,
  ctx?: AICallCtx,
): Promise<{ stopIdx: number; activities: string[] }[]> {
  if (stops.length === 0) return []

  const stopList = stops.map(s =>
    `${s.stopIdx}. ${s.locationName}${s.locationState ? ', ' + s.locationState : ''} (${s.nights} night${s.nights !== 1 ? 's' : ''})`
  ).join('\n')

  const prompt = `For each destination stop below, suggest 3–5 specific, interesting activities tailored to the location. Return ONLY valid JSON — no prose, no markdown.

Stops:
${stopList}

Return this exact JSON array:
[
  { "stopIdx": 0, "activities": ["Activity one", "Activity two", "Activity three"] }
]

Rules:
- Activities must be specific to the actual location — no generic suggestions
- Include nearby landmarks, parks, historic sites, scenic drives, local attractions
- Keep each activity name concise (5–8 words max)
- 3 activities minimum, 5 maximum per stop`

  const model = 'claude-sonnet-4-5'
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  if (ctx?.userId) {
    logAIUsage({
      userId: ctx.userId,
      sessionId: ctx.sessionId ?? null,
      tripId: ctx.tripId ?? null,
      callType: 'ACTIVITIES',
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }).catch(() => {})
  }

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : []
  } catch {
    return []
  }
}

export async function analyzeFeedbackAI(feedbackItems: any[], ctx?: AICallCtx): Promise<string> {
  const prompt = `Analyze these user feedback submissions for RoamReady, an RV/van/camping trip planning app.

Feedback items:
${JSON.stringify(feedbackItems, null, 2)}

Please:
1. Cluster the feedback into themes
2. Identify the top 5 most requested features
3. Flag any critical bugs
4. Provide prioritized recommendations for the product roadmap

Format your response in clear sections with headers.`

  const model = 'claude-sonnet-4-5'
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  if (ctx?.userId) {
    logAIUsage({
      userId: ctx.userId,
      sessionId: ctx.sessionId ?? null,
      tripId: ctx.tripId ?? null,
      callType: 'FEEDBACK',
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }).catch(() => {})
  }

  return response.content[0].type === 'text' ? response.content[0].text : ''
}

export async function generateRouteHighlightsAI(
  origin: string,
  destination: string,
  highwayRoute: string | null | undefined,
  ctx?: AICallCtx,
): Promise<string> {
  const viaText = highwayRoute ? ` traveling via ${highwayRoute}` : ''
  const prompt = `List 5 to 8 interesting points of interest, scenic stops, or notable landmarks along the drive from ${origin} to ${destination}${viaText}. Include things like national monuments, scenic overlooks, quirky roadside attractions, historic sites, state border crossings, or anything worth slowing down for. For each one give the name and a one sentence description of why it is worth noting. Format as a simple list with one item per line. Start each line with the place name followed by a dash and the description. Do not include numbered prefixes or bullet characters.`

  const model = 'claude-haiku-4-5-20251001'
  const response = await client.messages.create({
    model,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  })

  if (ctx?.userId) {
    logAIUsage({
      userId: ctx.userId,
      sessionId: ctx.sessionId ?? null,
      tripId: ctx.tripId ?? null,
      callType: 'HIGHLIGHTS',
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }).catch(() => {})
  }

  return response.content[0].type === 'text' ? response.content[0].text.trim() : ''
}

/** Distill a PlanningSession transcript into a short prose summary that the
 *  modify-mode system prompt can consume. Run once per trip — at promote time
 *  for new trips, lazily on first modify-with-AI open for legacy trips.
 *
 *  Cheapest available model (haiku) — this is private system-prompt context,
 *  never user-visible, and an over-summarized result is far less harmful than
 *  losing the conversation continuity entirely. Returns null on any failure
 *  so the caller can fall back gracefully (modify still works without it).
 *
 *  Cost envelope: with a typical 5–15 turn planning chat (~1.5–4k input
 *  tokens) and ~200–400 output tokens, this lands around $0.003–$0.006 per
 *  summary at current haiku-4-5 pricing ($1/M input, $5/M output). One-shot
 *  per trip, so the lifetime cost is negligible. */
export async function generatePlanningContextSummary(
  messages: Array<{ role: string; content: string }>,
  ctx?: AICallCtx,
): Promise<string | null> {
  // Empty / null guard — nothing to summarize.
  if (!Array.isArray(messages) || messages.length === 0) return null

  // Truncate at the boundary, not in the middle of a turn — we keep the most
  // recent ~30 turns. Anthropic accepts much more, but planning chats rarely
  // run long enough to bump this; the cap is a defensive guard against
  // pathological cases that would inflate the haiku call cost.
  const trimmed = messages.slice(-30).map(m => ({
    role: String(m.role ?? '').trim() || 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
  })).filter(m => m.content.length > 0)

  if (trimmed.length === 0) return null

  // Render the transcript as plain text for the summarizer. We pass it as a
  // single user message rather than as Anthropic-shape role-tagged turns
  // because we want haiku to *summarize* the conversation, not continue it.
  const transcript = trimmed
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n---\n\n')

  const systemPrompt =
    "You are extracting context from a trip-planning conversation between a user and a travel-planning AI. " +
    "The trip itself has already been built — your job is to capture WHO this user is and WHAT they care about, " +
    "so a future AI helping them modify the trip doesn't have to ask them again.\n\n" +
    "Write a concise summary (under 300 words) capturing:\n" +
    "- The user's original ask in their own words (paraphrase ok)\n" +
    "- Their constraints, preferences, and concerns expressed conversationally\n" +
    "- Reasoning behind specific choices made during planning\n" +
    "- Anything the user explicitly excluded or rejected, and why\n" +
    "- Their tone and travel style (laid-back vs ambitious, family-focused vs solo, etc.) if discernible\n\n" +
    "DO NOT include:\n" +
    "- The trip itinerary itself (stops, dates, drive times — those are in trip data)\n" +
    "- Generic AI replies or filler\n" +
    "- Anything that's already on the user's profile (rig, party size, etc. — assume those are available separately)\n\n" +
    "Output: plain text, no headers, no markdown. Direct prose suitable for system-prompt injection."

  const model = 'claude-haiku-4-5-20251001'

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 400,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content:
            "Here is the planning conversation transcript. Produce the summary as instructed.\n\n" +
            transcript,
        },
      ],
    })

    if (ctx?.userId) {
      logAIUsage({
        userId: ctx.userId,
        sessionId: ctx.sessionId ?? null,
        tripId: ctx.tripId ?? null,
        callType: 'PLANNING_SUMMARY',
        model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }).catch(() => {})
    }

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
    return text.length > 0 ? text : null
  } catch (err: any) {
    // Best-effort: never throw. Caller decides whether to retry, fall back,
    // or just skip the summary section in the system prompt.
    console.error(
      `[AI planning-summary] generation failed for tripId=${ctx?.tripId ?? 'n/a'} ` +
      `userId=${ctx?.userId ?? 'n/a'}:`,
      err?.message ?? err,
    )
    return null
  }
}
