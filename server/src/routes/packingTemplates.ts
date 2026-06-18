// USER-level saved packing templates (FR-SAVED-PACKING). Mounted at
// /api/v1/packing-templates — a dedicated router (NOT under /trips/:id) so the
// literal `templates` path can never collide with the trips `/:id` route.
//
// The whole CRUD is Pro-gated via requireFeature('packingListGenerator') so the
// existing paywall copy ("AI Packing List") applies. Copy-from-previous-trip is
// the FREE path and lives on the trips router instead (no gate).
import { Router } from 'express'
import { requireAuth, requireFeature } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import { PackingTemplateCreateSchema } from '../schemas'
import {
  createPackingTemplate, listPackingTemplates, getPackingTemplate, deletePackingTemplate,
} from '../controllers/packingTemplates'

export const packingTemplatesRouter = Router()

packingTemplatesRouter.use(requireAuth, requireVerifiedEmail, requireFeature('packingListGenerator'))

packingTemplatesRouter.get('/', listPackingTemplates as any)
packingTemplatesRouter.post('/', validateBody(PackingTemplateCreateSchema), createPackingTemplate as any)
packingTemplatesRouter.get('/:id', getPackingTemplate as any)
packingTemplatesRouter.delete('/:id', deletePackingTemplate as any)
