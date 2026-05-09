// Sentry instrumentation. THIS FILE MUST BE IMPORTED FIRST in src/index.ts —
// before any other module that should be auto-instrumented (Express, Prisma,
// HTTP/HTTPS, fs, etc.). The Sentry Node SDK v8+ uses OpenTelemetry under the
// hood, and OTel can only patch modules whose `require()` happens AFTER
// Sentry.init(). If you import express before this file, Express won't be
// traced — you'll get errors but no per-request performance/breadcrumb data.
//
// We also load dotenv from the master .env at the project root here, mirroring
// the path resolution in src/config/env.ts. Doing it inside this file means
// SENTRY_DSN_SERVER is available to Sentry.init() before any other import
// runs, so we don't need to thread the DSN through any other code path.
import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import * as Sentry from '@sentry/node'
import { nodeProfilingIntegration } from '@sentry/profiling-node'

Sentry.init({
  dsn: process.env.SENTRY_DSN_SERVER,
  environment: process.env.SENTRY_ENVIRONMENT || 'development',
  integrations: [nodeProfilingIntegration()],
  // 10% sampling — gives us a usable performance dataset without paying the
  // full per-request OTel overhead on production traffic. Tune up if we ever
  // need higher fidelity for a specific debug; tune down if cost ramps.
  tracesSampleRate: 0.1,
  profilesSampleRate: 0.1,
  // Globally disable Sentry when no DSN is configured (test runs, local dev
  // for contributors without Sentry access). enabled=false makes init() a
  // no-op so we never spam "Failed to send envelope" warnings.
  enabled: !!process.env.SENTRY_DSN_SERVER,
})
