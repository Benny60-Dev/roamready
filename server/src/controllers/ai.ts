import { Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { chatWithAI, generatePackingListAI, analyzeFeedbackAI } from '../services/ai'

// Soft cap: inject a "wrap up" system message and let Claude actually respond
// (so it has a chance to emit the <itinerary> JSON block).
// Hard cap: short-circuit purely for cost protection.
const SOFT_CAP = 35
const HARD_CAP = 60

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

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return 'not set'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Builds a compact live-state system message for the modify flow.
 *  Injected before every Claude call so the AI always sees the actual stop list,
 *  not just what it remembers from conversation history. */
function buildLiveTripState(trip: any): string {
  const stops: any[] = trip.stops ?? []
  const stopNames = stops.map((s: any) => s.locationName.toLowerCase())

  const stopLines = stops.map((s: any) => {
    const name = s.locationState ? `${s.locationName}, ${s.locationState}` : s.locationName
    const parts = [`${s.order}. ${name}`, s.type, `${s.nights} night${s.nights !== 1 ? 's' : ''}`, s.bookingStatus]
    if (s.campgroundName) parts.push(`campground: ${s.campgroundName}`)
    return parts.join(' | ')
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
    '',
    'SUPPORTED ACTIONS AND JSON FORMAT:',
    '',
    'Add a stop:',
    '<modify>{"action":"add_stop","locationName":"Sedona","locationState":"AZ","type":"DESTINATION","nights":1,"afterStopOrder":1}</modify>',
    '  afterStopOrder: the order number of the stop AFTER which to insert. Omit or set to null to append at end.',
    '  nights parsing rules: "one night" = 1 | "two nights" or "a couple nights" = 2 | "three nights" = 3 | "a few nights" = 2 | "the weekend" = 2 | "three days" = 2 (days minus 1) | default to 1 if ambiguous. Parse nights EXACTLY as stated — do not infer or round up.',
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
    'EXAMPLE — correct assistant response when user says "Add Moab for one night after Flagstaff":',
    'Sure! I\'ll add Moab, UT for one night after Flagstaff.',
    '<modify>{"action":"add_stop","locationName":"Moab","locationState":"UT","type":"DESTINATION","nights":1,"afterStopOrder":2}</modify>',
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
    `Dates: ${fmtDate(trip.startDate)} – ${fmtDate(trip.endDate)}`,
    `Total nights: ${trip.totalNights ?? 'not set'}`,
    '',
    'Current stops in order:',
    stopLines.length ? stopLines.join('\n') : '(no stops yet)',
    '=== END MODIFY MODE INSTRUCTIONS ===',
  ].join('\n')
}

export async function chat(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { messages, tripId, sessionId, context } = req.body
    if (!messages || !Array.isArray(messages)) throw new AppError('Messages required', 400)

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
        include: { stops: { orderBy: { order: 'asc' } } },
      })
    }

    const stripModifyTags = (content: string) => content.replace(/<modify>[\s\S]*?<\/modify>/g, '').trim()

    // Fix B: phrases Claude uses when it thinks it performed a modification without emitting a tag
    const MOD_CLAIM_RE = /\b(i('ll| will| just| have)? (add(ed)?|remov(ed)?|delet(ed)?|chang(ed)?|updat(ed)?|adjust(ed)?|mov(ed)?|insert(ed)?)|adding|removing|done!|applied|✅)\b/i

    // Cap history at the last 10 messages before sending to Claude.
    const HISTORY_CAP = 10
    const nonSystemMessages = messages.filter((m: any) => m.role !== 'system')
    const systemMessages = messages.filter((m: any) => m.role === 'system')
    const cappedMessages = [
      ...systemMessages,
      ...nonSystemMessages.slice(-HISTORY_CAP),
    ]

    // Fix B: Strip <modify> tags from assistant history before sending to Claude.
    // System prompt (now first in combined prompt per Fix A) teaches the format — history
    // tag-less responses would teach the wrong pattern if left in.
    const cleanedMessages = cappedMessages.map((m: any) =>
      m.role === 'assistant' ? { ...m, content: stripModifyTags(m.content) } : m
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
    }

    // Surprise-trip variety: detect "surprise trip" in the latest user message,
    // then pull the user's last 5 surprise destinations to exclude and pick a
    // random landscape vibe to nudge variety. Falls through silently on any error.
    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')
    const isSurprise = typeof lastUserMsg?.content === 'string'
      && lastUserMsg.content.toLowerCase().includes('surprise trip')

    let recentSurpriseDestinations: string[] | undefined
    let surpriseVibe: string | undefined
    if (isSurprise) {
      try {
        const recent = await prisma.trip.findMany({
          where: {
            userId: req.user!.id,
            aiConversation: { not: Prisma.JsonNull },
          },
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: {
            stops: {
              where: { type: 'DESTINATION' },
              orderBy: { order: 'asc' },
              take: 1,
            },
          },
        })
        recentSurpriseDestinations = recent
          .filter(t => JSON.stringify(t.aiConversation).toLowerCase().includes('surprise trip'))
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
    if (liveStateMsg) {
      const hasTag = /<modify>/.test(response)
      console.log('[AI modify] response hasModifyTag=%s preview=%s', hasTag, response.slice(0, 200))

      // Fix C: Auto-retry if the response describes a modification but omits the <modify> tag.
      // One retry only — if the second attempt also lacks a tag, return it as-is.
      if (!hasTag && MOD_CLAIM_RE.test(response)) {
        console.warn('[AI modify] No <modify> tag detected in modification response — auto-retrying with reminder')
        const retryMessages = [
          ...messagesForAI,
          { role: 'assistant' as const, content: stripModifyTags(response) },
          {
            role: 'user' as const,
            content:
              '[SYSTEM REMINDER: Your previous response described a trip modification but is missing the required <modify> JSON block. ' +
              'Without the <modify> tag, NO change will be made — the user will be confused. ' +
              'Please repeat your response and include the <modify> JSON block exactly as specified in the instructions above.]',
          },
        ]
        const retryResponse = await chatWithAI(retryMessages, userProfile, recentSurpriseDestinations, surpriseVibe, aiCtx)
        const retryHasTag = /<modify>/.test(retryResponse)
        console.log('[AI modify] retry hasModifyTag=%s preview=%s', retryHasTag, retryResponse.slice(0, 200))
        if (retryHasTag) {
          response = retryResponse
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
            // Strip <modify> tags from stored history so reloaded conversations don't
            // make Claude believe it already performed those actions in future sessions.
            content: m.role === 'assistant' ? stripModifyTags(m.content) : m.content,
          }))
        // Fix B: strip <modify> tags from stored history (both old and new responses) so future
        // reloads don't contain tags that confuse the modify-or-not pattern in history.
        persistable.push({ role: 'assistant', content: stripModifyTags(response) })

        await prisma.trip.update({
          where: { id: tripId },
          data: context === 'modify'
            ? { modifyConversation: persistable }
            : { aiConversation: persistable },
        })
      }
    }

    res.json({ message: response })
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
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { rigs: { where: { isDefault: true } }, travelProfile: true },
    })

    const response = await chatWithAI(
      messages,
      {
        rigs: user?.rigs,
        travelProfile: user?.travelProfile,
        homeLocation: user?.homeLocation,
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
    const trip = await prisma.trip.findFirst({
      where: { id: tripId, userId: req.user!.id },
      include: { stops: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { rigs: { where: { isDefault: true } }, travelProfile: true },
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
