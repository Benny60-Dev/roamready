// Sentry instrumentation MUST be the very first import — see instrument.ts
// for the full reasoning. It also calls dotenv.config() so process.env is
// populated before anything else runs (the original './config/env' import
// below remains as a no-op redundancy / status log; safe to keep).
import './instrument'
import './config/env'

// ─── Required environment variable check ──────────────────────────────────────
// Runs immediately at startup before any routes or DB connections are opened.
// Add any key here that will cause silent failures if absent.
//
// Stripe vars are split into their own list because they have stricter
// semantics: a 'placeholder' literal in any of them silently mis-bills users
// (wrong tier, wrong price, broken webhooks). In production we exit(1) rather
// than boot a server that will sell the wrong tier; in development we warn
// only so contributors without Stripe access can still run the app.
;(function checkEnv() {
  const REQUIRED: Array<{ key: string; feature: string }> = [
    { key: 'ANTHROPIC_API_KEY',  feature: 'AI features will not work' },
    { key: 'DATABASE_URL',       feature: 'database connection will fail' },
    { key: 'JWT_SECRET',         feature: 'authentication will be broken' },
    { key: 'JWT_REFRESH_SECRET', feature: 'token refresh will be broken' },
  ]
  const STRIPE_REQUIRED: Array<{ key: string; feature: string }> = [
    { key: 'STRIPE_SECRET_KEY',                      feature: 'Stripe API calls will fail' },
    { key: 'STRIPE_WEBHOOK_SECRET',                  feature: 'webhook signature verification will fail' },
    { key: 'STRIPE_PRO_MONTHLY_PRICE_ID',            feature: 'Pro monthly checkout/tier detection will mis-bill' },
    { key: 'STRIPE_PRO_ANNUAL_PRICE_ID',             feature: 'Pro annual checkout/tier detection will mis-bill' },
    { key: 'STRIPE_PRO_FOUNDER_MONTHLY_PRICE_ID',    feature: 'founder-rate monthly checkouts will fail — early-adopter users cannot upgrade' },
    { key: 'STRIPE_PRO_FOUNDER_ANNUAL_PRICE_ID',     feature: 'founder-rate annual checkouts will fail — early-adopter users cannot upgrade' },
  ]
  const RED    = '\x1b[31m'
  const YELLOW = '\x1b[33m'
  const RESET  = '\x1b[0m'

  let anyMissing = false
  for (const { key, feature } of REQUIRED) {
    if (!process.env[key]) {
      console.error(`${RED}[ENV] MISSING REQUIRED ENV VAR: ${key} — ${feature}${RESET}`)
      anyMissing = true
    }
  }
  if (anyMissing) {
    console.error(`${RED}[ENV] Fix missing vars in roamready/.env then restart the server.${RESET}`)
  }

  // Stripe-specific check: missing OR contains the literal word 'placeholder'
  // (case-insensitive) — both indicate an unconfigured env. The .env.example
  // ships with values like 'sk_test_placeholder', so a sloppy copy-paste leaves
  // the keys "set" but useless.
  const isProd = process.env.NODE_ENV === 'production'
  const stripeIssues: string[] = []
  for (const { key, feature } of STRIPE_REQUIRED) {
    const val = process.env[key]
    if (!val) {
      stripeIssues.push(`${key} is missing — ${feature}`)
    } else if (/placeholder/i.test(val)) {
      stripeIssues.push(`${key} contains 'placeholder' — ${feature}`)
    }
  }
  if (stripeIssues.length > 0) {
    if (isProd) {
      console.error(`${RED}[ENV] Stripe configuration invalid — refusing to boot in production:${RESET}`)
      for (const msg of stripeIssues) console.error(`${RED}  • ${msg}${RESET}`)
      console.error(`${RED}[ENV] Fix the above in your production env then redeploy. Booting now would risk billing users at the wrong tier.${RESET}`)
      process.exit(1)
    } else {
      console.warn(`${YELLOW}[ENV] Stripe configuration warnings (dev only — would exit(1) in production):${RESET}`)
      for (const msg of stripeIssues) console.warn(`${YELLOW}  • ${msg}${RESET}`)
    }
  }

  // RESEND_API_KEY — separate from the Stripe block because it has its
  // own escalation policy: missing key is a HARD-FAIL in production
  // (transactional emails like verification + trial-end + payment-failed
  // silently drop, which is worse than refusing to boot), but a SOFT
  // warning in dev so contributors without Resend access can still run
  // the app. Same pattern as the Stripe gate above.
  if (!process.env.RESEND_API_KEY) {
    if (isProd) {
      console.error(`${RED}[ENV] RESEND_API_KEY is missing — refusing to boot in production. Transactional emails (verification, trial-end, payment-failed) would silently fail.${RESET}`)
      process.exit(1)
    } else {
      console.warn(`${YELLOW}[ENV] RESEND_API_KEY is missing (dev only — would exit(1) in production). Email-sending paths will fail at runtime.${RESET}`)
    }
  }
})()

import * as Sentry from '@sentry/node'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import { errorHandler } from './middleware/errorHandler'
import { prisma } from './utils/prisma'
import { authRouter } from './routes/auth'
import { usersRouter } from './routes/users'
import { tripsRouter } from './routes/trips'
import { aiRouter } from './routes/ai'
import { campgroundsRouter } from './routes/campgrounds'
import { weatherRouter } from './routes/weather'
import { resourcesRouter } from './routes/resources'
import { maintenanceRouter } from './routes/maintenance'
import { journalRouter } from './routes/journal'
import { feedbackRouter } from './routes/feedback'
import { subscriptionsRouter } from './routes/subscriptions'
import { handleWebhook } from './controllers/subscriptions'
import { notificationsRouter } from './routes/notifications'
import { adminRouter } from './routes/admin'
import { sessionsRouter } from './routes/sessions'
import { internalRouter } from './routes/internal'

const app = express()

app.use(helmet())
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
}))
app.use(compression())
app.use(cookieParser())

// Webhook route must be registered before express.json() so the body arrives as a raw Buffer.
// express.json() would parse it into an object first, breaking Stripe signature verification.
app.post('/api/v1/subscriptions/webhook', express.raw({ type: 'application/json' }), handleWebhook)

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Per-user rate limit. The previous max=200 / 15 min / IP was too tight for an
// authenticated SPA: a single first-mount of TripSummaryPage on a 7-stop trip
// already burns ~9 requests via the auto-cascade, plus ~3 more for trip / weather
// / activity-gen, plus the rig + booking-page fetches. Households behind one NAT
// shared the budget, which compounded the issue.
//
// Now: 1000 / 15 min / authenticated user (decoded from the JWT directly here
// since this middleware runs BEFORE per-router requireAuth). Unauthenticated
// requests fall back to per-IP. JWT verification matches middleware/auth.ts —
// same JWT_SECRET env var, same `userId` claim name. standardHeaders=true so the
// client (and DevTools) can read RateLimit-Remaining headers and recover from
// 429s gracefully.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    try {
      const authHeader = req.headers.authorization
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7)
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId?: string }
        if (decoded.userId) return `user:${decoded.userId}`
      }
    } catch {
      // Invalid / expired / missing token — fall through to IP-based limiting
    }
    return `ip:${req.ip}`
  },
})
app.use('/api/', limiter)

app.use('/api/v1/auth', authRouter)
app.use('/api/v1/users', usersRouter)
app.use('/api/v1/trips', tripsRouter)
app.use('/api/v1/ai', aiRouter)
app.use('/api/v1/campgrounds', campgroundsRouter)
app.use('/api/v1/weather', weatherRouter)
app.use('/api/v1/resources', resourcesRouter)
app.use('/api/v1/maintenance', maintenanceRouter)
app.use('/api/v1/journal', journalRouter)
app.use('/api/v1/feedback', feedbackRouter)
app.use('/api/v1/subscriptions', subscriptionsRouter)
app.use('/api/v1/notifications', notificationsRouter)
app.use('/api/v1/admin', adminRouter)
app.use('/api/v1/sessions', sessionsRouter)
// Internal endpoints (cron jobs, etc.) — auth is via X-Cron-Secret header
// inside each handler. NOT mounted behind requireAuth.
app.use('/api/v1/internal', internalRouter)

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

// Sentry's Express error handler — must be registered AFTER all routes and
// BEFORE our custom errorHandler. It captures the error, ships it to Sentry,
// and then calls next(err) so our existing errorHandler can still produce
// the JSON 500 response. No changes to errorHandler or any controller needed.
Sentry.setupExpressErrorHandler(app)

app.use(errorHandler)

// ─── Startup migration: fix first/last stops incorrectly typed as OVERNIGHT_ONLY ─
async function fixEndpointStopTypes() {
  try {
    // Fix all order=1 stops that are OVERNIGHT_ONLY
    const firstFix = await prisma.stop.updateMany({
      where: { order: 1, type: 'OVERNIGHT_ONLY' },
      data: { type: 'DESTINATION' },
    })
    if (firstFix.count > 0) {
      console.log(`[migration] Fixed ${firstFix.count} first stop(s): OVERNIGHT_ONLY → DESTINATION`)
    }

    // Fix last stops: fetch the highest-order stop per trip in one query, then batch-update
    const tripsWithLastStop = await prisma.trip.findMany({
      select: {
        id: true,
        stops: { select: { id: true, type: true }, orderBy: { order: 'desc' }, take: 1 },
      },
    })
    const lastStopIds = tripsWithLastStop
      .map(t => t.stops[0])
      .filter(s => !!s && s.type === 'OVERNIGHT_ONLY')
      .map(s => s!.id)

    if (lastStopIds.length > 0) {
      await prisma.stop.updateMany({
        where: { id: { in: lastStopIds } },
        data: { type: 'DESTINATION' },
      })
      console.log(`[migration] Fixed ${lastStopIds.length} last stop(s): OVERNIGHT_ONLY → DESTINATION`)
    }
  } catch (e) {
    console.error('[migration] fixEndpointStopTypes failed (non-fatal):', e)
  }
}

const PORT = process.env.PORT || 3001
app.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`RoamReady server running on port ${PORT}`)
  await fixEndpointStopTypes()
})

export default app
