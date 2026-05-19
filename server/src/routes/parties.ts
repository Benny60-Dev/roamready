import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import {
  PartyCreateSchema,
  PartyUpdateSchema,
  PersonCreateSchema,
  PersonUpdateSchema,
  PetCreateSchema,
  PetUpdateSchema,
} from '../schemas'
import {
  getParties,
  getDefaultParty,
  createParty,
  updateParty,
  deleteParty,
  createPerson,
  updatePerson,
  deletePerson,
  createPet,
  updatePet,
  deletePet,
} from '../controllers/parties'

/**
 * Travel Party routes. Mounted at /api/v1/users/me/parties in index.ts.
 *
 * URL hierarchy reflects ownership: a party belongs to a user, and people
 * + pets belong to a party. Matches the spirit of /me/rigs (user-owned
 * resource) but with one more level of nesting because party rows have
 * their own child collections.
 *
 * NOT feature-gated for v1 — every authenticated, verified user can
 * manage their travel party. The AI quality argument: party data drives
 * better trip plans for Free users too, so gating it behind PRO would
 * degrade the free-tier output.
 */
export const partiesRouter = Router()

partiesRouter.use(requireAuth, requireVerifiedEmail)

// Party-level
partiesRouter.get('/', getParties as any)
partiesRouter.get('/default', getDefaultParty as any)
partiesRouter.post('/', validateBody(PartyCreateSchema), createParty as any)
partiesRouter.put('/:partyId', validateBody(PartyUpdateSchema), updateParty as any)
partiesRouter.delete('/:partyId', deleteParty as any)

// People
partiesRouter.post('/:partyId/people', validateBody(PersonCreateSchema), createPerson as any)
partiesRouter.put('/:partyId/people/:id', validateBody(PersonUpdateSchema), updatePerson as any)
partiesRouter.delete('/:partyId/people/:id', deletePerson as any)

// Pets
partiesRouter.post('/:partyId/pets', validateBody(PetCreateSchema), createPet as any)
partiesRouter.put('/:partyId/pets/:id', validateBody(PetUpdateSchema), updatePet as any)
partiesRouter.delete('/:partyId/pets/:id', deletePet as any)
