// Internal endpoints — meant for an external scheduler (Vercel Cron,
// GitHub Actions, cron-job.org, etc.), NOT for browser/app traffic.
// Each handler validates the X-Cron-Secret header against CRON_SECRET
// in env. We deliberately mount this router OUTSIDE requireAuth — the
// shared-secret is the only auth layer.
import { Router } from 'express'
import { trialEndingReminder, ohvLinkCheck } from '../controllers/cron'

export const internalRouter = Router()

// Each handler validates X-Cron-Secret internally. Add others
// (e.g. trial-cleanup, weekly-digest) here as they're built.
internalRouter.get('/cron/trial-ending', trialEndingReminder)
// Monthly OHV resource link health check (emails ADMIN_EMAIL only on failures).
internalRouter.get('/cron/ohv-link-check', ohvLinkCheck)
