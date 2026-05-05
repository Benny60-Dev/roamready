import { Router } from 'express'
import { requireAuth, requireFeature } from '../middleware/auth'
import { getAllJournals, getTripJournal, upsertEntry, uploadPhotos } from '../controllers/journal'

export const journalRouter = Router()
journalRouter.use(requireAuth)

// Reads stay open: a downgraded user can still see their own past journal
// entries. Only writes are gated.
journalRouter.get('/', getAllJournals as any)
journalRouter.get('/:tripId', getTripJournal as any)
journalRouter.post('/:stopId', requireFeature('tripJournal'), upsertEntry as any)
journalRouter.put('/:stopId', requireFeature('tripJournal'), upsertEntry as any)
journalRouter.post('/:stopId/photos', requireFeature('tripJournal'), uploadPhotos as any)
