import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth'
import {
  getMe,
  updateMe,
  deleteMe,
  getRigs,
  createRig,
  updateRig,
  deleteRig,
  getTravelProfile,
  upsertTravelProfile,
  getMemberships,
  createMembership,
  updateMembership,
  deleteMembership,
} from '../controllers/users'

export const usersRouter = Router()
usersRouter.use(requireAuth)

usersRouter.get('/me', getMe as any)
usersRouter.put('/me', updateMe as any)
usersRouter.delete('/me', deleteMe as any)

usersRouter.get('/me/rigs', getRigs as any)
usersRouter.post('/me/rigs', createRig as any)
usersRouter.put('/me/rigs/:id', updateRig as any)
usersRouter.delete('/me/rigs/:id', deleteRig as any)

usersRouter.get('/me/travel-profile', getTravelProfile as any)
usersRouter.put('/me/travel-profile', upsertTravelProfile as any)

usersRouter.get('/me/memberships', getMemberships as any)
usersRouter.post('/me/memberships', createMembership as any)
usersRouter.put('/me/memberships/:id', updateMembership as any)
usersRouter.delete('/me/memberships/:id', deleteMembership as any)
