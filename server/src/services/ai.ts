import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'

const apiKey = process.env.ANTHROPIC_API_KEY
console.log('[AI] ANTHROPIC_API_KEY at init (first 10):', apiKey ? apiKey.slice(0, 10) : 'UNDEFINED')

// dotenv imports are hoisted before dotenv.config() runs, so the key may be
// undefined here. Fall back to reading the root .env directly.
const resolvedKey = apiKey ||
  (() => {
    try {
      const envFile = fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8')
      return envFile.match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim()
    } catch {
      return undefined
    }
  })()

if (!resolvedKey) {
  console.error('[AI] ANTHROPIC_API_KEY is not set — AI features will fail')
}

const client = new Anthropic({ apiKey: resolvedKey })

export async function chatWithAI(messages: Array<{ role: 'user' | 'assistant'; content: string }>, userProfile: any) {
  const systemPrompt = `You are RoamReady's AI trip planner. You ONLY help users plan outdoor trips — RV routes, van life journeys, car camping adventures, campground recommendations, OHV destinations, weather along routes, fuel costs, packing lists, and travel logistics.

If a user asks about ANYTHING unrelated to outdoor travel and trip planning — politics, relationships, medical advice, legal advice, other products, general knowledge questions, or any other off-topic subject — respond with exactly this: "I'm RoamReady's trip planning assistant and I can only help with outdoor travel planning. Is there a trip I can help you plan today?" Do not engage with off-topic questions under any circumstances. Do not be rude but be firm and redirect immediately back to trip planning. Stay focused on helping users plan amazing outdoor adventures.

You have access to the user's profile: ${JSON.stringify(userProfile)}

Trip planning rules:
- Never ask for information already in their profile (rig size, pets, budget, home base, memberships, accessibility needs)
- Ask only what you need: destination, dates, and must-see stops
- Maximum 3 questions before building the itinerary
- When you have enough information, respond with a JSON itinerary block inside <itinerary> tags — after the JSON block, do NOT add any closing message asking the user to click a button, build the itinerary, or take any UI action; the interface detects the itinerary automatically and shows the build button on its own
- Stop "type" must be exactly one of: DESTINATION, OVERNIGHT_ONLY, HOME — never use TRAVEL or any other value
- Always include the trip starting location as the first stop in the itinerary with type HOME and order 1. This is the departure point and should always be the first entry in the stops array regardless of whether the user mentioned it explicitly. Use the user's homeLocation from their profile as this stop's locationName. Set nights to 0 for the HOME stop.
- The FIRST stop (order: 1) must always be HOME type — NEVER DESTINATION or OVERNIGHT_ONLY
- The LAST stop must always be DESTINATION — NEVER OVERNIGHT_ONLY
- OVERNIGHT_ONLY is exclusively for mid-route transit stops where the traveler is simply sleeping before continuing the next morning — it is never the trip origin or final destination
- Always consider rig compatibility — never suggest campgrounds incompatible with their rig
- For toy haulers, prioritize OHV destinations matching their terrain preferences
- For vans, prioritize BLM/dispersed/Harvest Hosts over hookup campgrounds
- For car campers, include tent-only, walk-in, and backcountry sites
- Apply military campground options only if user has military/first responder status
- Apply membership discounts automatically
- Starting location confirmation rules (must happen before any other trip questions):
  - If the user says "home", "leaving from home", "starting from home", "from home", or anything else indicating they are departing from their home location, respond with exactly this format: "Perfect — I'll use your home address in [CITY] as the starting point. Now where are we headed?" — replacing [CITY] with only the city name extracted from their homeLocation in their profile. Never include a street address, zip code, or any other address detail — city name only.
  - If the user provides a specific city as their starting point (e.g. "I'm leaving from Austin"), confirm it back before asking anything else: "Got it — starting from [City, State]. Where are we headed?"
  - Always confirm the starting location as the very first response before asking any other questions about the trip.
- Be warm, knowledgeable, and conversational — like a well-traveled friend

Itinerary JSON format:
{
  "name": "Trip name",
  "totalMiles": 0,
  "totalNights": 0,
  "estimatedFuel": 0,
  "estimatedCamp": 0,
  "stops": [
    {
      "order": 1,
      "type": "HOME",
      "locationName": "Austin",
      "locationState": "TX",
      "nights": 0,
      "campgroundName": null,
      "siteRate": 0,
      "estimatedFuel": 0,
      "hookupType": "",
      "isPetFriendly": true,
      "isMilitaryOnly": false
    },
    {
      "order": 2,
      "type": "DESTINATION",
      "locationName": "",
      "locationState": "",
      "nights": 1,
      "campgroundName": "",
      "siteRate": 0,
      "estimatedFuel": 0,
      "hookupType": "",
      "isPetFriendly": true,
      "isMilitaryOnly": false
    }
  ]
}`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  })

  return response.content[0].type === 'text' ? response.content[0].text : ''
}

export async function generatePackingListAI(trip: any, user: any): Promise<any[]> {
  const rig = user?.rigs?.[0]
  const profile = user?.travelProfile

  const prompt = `Generate a comprehensive packing list for this trip:

Trip: ${trip.name}
Nights: ${trip.totalNights || trip.stops?.reduce((sum: number, s: any) => sum + (s.nights || 1), 0) || 'Unknown'}
Vehicle: ${rig?.vehicleType || 'Unknown'}
Hookup preference: ${profile?.hookupPreference || 'Unknown'}
Adults: ${profile?.adults || 1}, Children: ${profile?.children || 0}
Has pets: ${profile?.hasPets || false}
Pet details: ${JSON.stringify(profile?.petDetails || {})}
Interests: ${JSON.stringify(profile?.interests || [])}
Toy hauler: ${rig?.isToyHauler || false}
Toys: ${JSON.stringify(rig?.toys || [])}

Return a JSON array of categories with items. Format:
[
  {
    "category": "Category Name",
    "items": [
      { "name": "Item name", "required": true/false, "checked": false }
    ]
  }
]`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : []
  } catch {
    return []
  }
}

export async function generateTripItineraryAI(trip: any, user: any): Promise<any[]> {
  const rig = user?.rigs?.[0]
  const profile = user?.travelProfile
  const stops = (trip.stops || []).sort((a: any, b: any) => a.order - b.order)

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
  }))

  const prompt = `Generate a detailed day-by-day itinerary for this RV/camping trip. You must return ONLY valid JSON — no prose, no markdown, no code fences.

Trip: ${trip.name}
Total miles: ${trip.totalMiles || 'unknown'}
Vehicle: ${rig?.vehicleType || 'RV'}
Interests: ${JSON.stringify(profile?.interests || [])}
Has pets: ${profile?.hasPets || false}
Toy hauler: ${rig?.isToyHauler || false}

Stops (in order):
${JSON.stringify(stopSummaries, null, 2)}

Rules:
- Return a JSON array of day entries (one per day of the trip)
- For each DRIVE day between two stops, include: highwayRoute (major highway route string such as "US-60 East → I-17 North → US-89 North" — official highway designations with cardinal directions, 2-5 highways in travel order separated by →, no city names), routeDescription (2-3 sentences about the drive, highways, scenery), terrainSummary (1 sentence), pointsOfInterest (array of 2-4 strings like "City, State - quick description")
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
    "pointsOfInterest": ["Location - description"],
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : []
  } catch {
    console.error('[generateTripItineraryAI] JSON parse failed, text:', text.slice(0, 200))
    return []
  }
}

export async function generateRouteStringsAI(trip: any): Promise<{ segmentIdx: number; route: string }[]> {
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : []
  } catch {
    return []
  }
}

export async function generateStopActivitiesAI(
  stops: Array<{ stopIdx: number; locationName: string; locationState?: string; nights: number }>
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : []
  } catch {
    return []
  }
}

export async function analyzeFeedbackAI(feedbackItems: any[]): Promise<string> {
  const prompt = `Analyze these user feedback submissions for RoamReady, an RV/van/camping trip planning app.

Feedback items:
${JSON.stringify(feedbackItems, null, 2)}

Please:
1. Cluster the feedback into themes
2. Identify the top 5 most requested features
3. Flag any critical bugs
4. Provide prioritized recommendations for the product roadmap

Format your response in clear sections with headers.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  return response.content[0].type === 'text' ? response.content[0].text : ''
}

export async function generateRouteHighlightsAI(
  origin: string,
  destination: string,
  highwayRoute: string | null | undefined,
): Promise<string> {
  const viaText = highwayRoute ? ` traveling via ${highwayRoute}` : ''
  const prompt = `List 5 to 8 interesting points of interest, scenic stops, or notable landmarks along the drive from ${origin} to ${destination}${viaText}. Include things like national monuments, scenic overlooks, quirky roadside attractions, historic sites, state border crossings, or anything worth slowing down for. For each one give the name and a one sentence description of why it is worth noting. Format as a simple list with one item per line. Start each line with the place name followed by a dash and the description. Do not include numbered prefixes or bullet characters.`

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  })

  return response.content[0].type === 'text' ? response.content[0].text.trim() : ''
}
