import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getAllJournals, getTripJournal, upsertEntry, uploadPhotos } from '../controllers/journal'

export const journalRouter = Router()
journalRouter.use(requireAuth)

journalRouter.get('/', getAllJournals as any)
journalRouter.get('/:tripId', getTripJournal as any)
journalRouter.post('/:stopId', upsertEntry as any)
journalRouter.put('/:stopId', upsertEntry as any)
journalRouter.post('/:stopId/photos', uploadPhotos as any)
