// Debug endpoints — dev/staging-only assistance for verifying Sentry plumbing.
// Mounted under /api/v1/debug behind requireAuth so unauthenticated callers
// can't trigger arbitrary 500s from the public internet (rate-limit budget,
// log-spam DoS, etc.).
//
// TODO: REMOVE BEFORE LAUNCH. Either delete this file + its mount in index.ts,
// or gate the route on NODE_ENV !== 'production'. Tracking under the
// "pre-launch debug surface cleanup" task.
import { Router } from 'express'
import { requireAuth } from '../middleware/auth'

export const debugRouter = Router()
debugRouter.use(requireAuth)

// Intentional throw — Sentry's Express error handler should catch this,
// report it, and the existing errorHandler middleware should respond with
// the standard 500 JSON shape. Used to verify the full backend → Sentry
// pipeline is wired correctly.
debugRouter.get('/sentry', (_req, _res) => {
  throw new Error('Sentry backend test — if you see this in Sentry, it works!')
})
