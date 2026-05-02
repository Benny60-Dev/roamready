import './config/env'

// ─── Required environment variable check ──────────────────────────────────────
// Runs immediately at startup before any routes or DB connections are opened.
// Add any key here that will cause silent failures if absent.
;(function checkEnv() {
  const REQUIRED: Array<{ key: string; feature: string }> = [
    { key: 'ANTHROPIC_API_KEY',  feature: 'AI features will not work' },
    { key: 'DATABASE_URL',       feature: 'database connection will fail' },
    { key: 'JWT_SECRET',         feature: 'authentication will be broken' },
    { key: 'JWT_REFRESH_SECRET', feature: 'token refresh will be broken' },
  ]
  const RED   = '\x1b[31m'
  const RESET = '\x1b[0m'
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
})()

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
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
import { bookingsRouter } from './routes/bookings'
import { sessionsRouter } from './routes/sessions'

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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
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
app.use('/api/v1/bookings', bookingsRouter)
app.use('/api/v1/sessions', sessionsRouter)

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

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
