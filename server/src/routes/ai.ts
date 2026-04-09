import { Router } from 'express'
import { requireAuth, requireOwner, AuthRequest } from '../middleware/auth'
import { chat, getChatHistory, generateItinerary, generatePackingList, analyzeFeedback } from '../controllers/ai'

export const aiRouter = Router()
aiRouter.use(requireAuth)

aiRouter.post('/chat', chat as any)
aiRouter.get('/chat/:tripId/history', getChatHistory as any)
aiRouter.post('/generate-itinerary', generateItinerary as any)
aiRouter.post('/generate-packing-list', generatePackingList as any)
aiRouter.post('/analyze-feedback', requireOwner as any, analyzeFeedback as any)
