import { Router } from 'express'
import { requireAuth, requireFeature } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import { JournalCreateSchema, JournalUpdateSchema } from '../schemas'
import {
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  upsertEntry,
  upsertRoutePoiEntry,
  uploadPhotos,
  upload,
} from '../controllers/journal'

export const journalRouter = Router()
journalRouter.use(requireAuth, requireVerifiedEmail)

// ─── Freeform diary CRUD ────────────────────────────────────────────────────
// Reads stay OPEN to all authenticated users (a downgraded user can still read
// their own diary). Writes keep the PRO gate via requireFeature('tripJournal').
journalRouter.get('/', listEntries as any)
journalRouter.post('/', requireFeature('tripJournal'), validateBody(JournalCreateSchema), createEntry as any)

// ─── Legacy per-stop journal (still live) ───────────────────────────────────
// The TripJournalPage UI POSTs to /journal/:stopId (upsert) and
// /journal/:stopId/photos. Registered BEFORE the /:id diary routes so the
// more specific /:stopId/photos path resolves, and kept at their original
// paths so the client needs no change. POST /:stopId does not collide with
// POST / above (param vs no-param).
// multer parses the multipart body into req.files (field name "photos",
// up to 10 per request, 10MB each — see the `upload` instance in the
// controller). Without this middleware req.files is undefined and every
// upload 400s "No files uploaded" — which is what shipped originally.
journalRouter.post('/:stopId/photos', requireFeature('tripJournal'), upload.array('photos', 10), uploadPhotos as any)
// Route-POI upsert (itinerary "stops along the way"). Literal "route-poi"
// prefix + two segments, so it never collides with POST /:stopId (one segment)
// or the /:id diary routes (one segment). Keyed on the POI's stable client id.
journalRouter.post('/route-poi/:routePoiId', requireFeature('tripJournal'), upsertRoutePoiEntry as any)
journalRouter.post('/:stopId', requireFeature('tripJournal'), upsertEntry as any)

// ─── Diary entry by id ──────────────────────────────────────────────────────
journalRouter.get('/:id', getEntry as any)
journalRouter.put('/:id', requireFeature('tripJournal'), validateBody(JournalUpdateSchema), updateEntry as any)
journalRouter.delete('/:id', requireFeature('tripJournal'), deleteEntry as any)
