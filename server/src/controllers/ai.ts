import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { chatWithAI, generatePackingListAI, analyzeFeedbackAI } from '../services/ai'

const TURN_LIMIT = 20 // max message entries (user + assistant combined) per planning session

const TURN_LIMIT_RESPONSE =
  "We've covered a lot of ground in this planning session! 🗺️ Your itinerary is ready to build. " +
  "Click **Build Full Itinerary** to save your trip, or start a **New Trip** if you'd like to plan a different adventure. Happy travels! 🚐"

export async function chat(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { messages, tripId } = req.body
    if (!messages || !Array.isArray(messages)) throw new AppError('Messages required', 400)

    // Enforce conversation turn limit to control costs and guide users toward completing their trip
    if (messages.length >= TURN_LIMIT) {
      return res.json({ message: TURN_LIMIT_RESPONSE, turnLimitReached: true })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        rigs: { where: { isDefault: true } },
        travelProfile: true,
        memberships: { where: { isActive: true } },
      },
    })

    const userProfile = {
      homeLocation: user?.homeLocation,
      rigs: user?.rigs,
      travelProfile: user?.travelProfile,
      memberships: user?.memberships?.map(m => m.type),
    }

    const response = await chatWithAI(messages, userProfile)

    // Save conversation to trip if tripId provided (strip any system-role entries before persisting)
    if (tripId) {
      const persistableMessages = messages.filter((m: any) => m.role !== 'system')
      await prisma.trip.update({
        where: { id: tripId },
        data: { aiConversation: persistableMessages.concat([{ role: 'assistant', content: response }]) },
      })
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

export async function generateItinerary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { messages } = req.body
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { rigs: { where: { isDefault: true } }, travelProfile: true },
    })

    const response = await chatWithAI(messages, {
      rigs: user?.rigs,
      travelProfile: user?.travelProfile,
      homeLocation: user?.homeLocation,
    })

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

    const packingList = await generatePackingListAI(trip, user)
    res.json(packingList)
  } catch (err) { next(err) }
}

export async function analyzeFeedback(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const feedbackItems = await prisma.feedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    const analysis = await analyzeFeedbackAI(feedbackItems)
    res.json({ analysis })
  } catch (err) { next(err) }
}
