// Sentry instrumentation for the React client. Imported FIRST in main.tsx —
// before React itself — so the SDK can patch fetch/XHR and install its
// global error handlers before any component code runs.
//
// Vite injects only env vars whose names start with VITE_ into the client
// bundle (security: prevents accidental leaks of server-side secrets). The
// DSN is the only sensitive-ish value here, and it's already designed to be
// public — Sentry DSNs identify the project but not the auth credential.
import * as Sentry from '@sentry/react'

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN_CLIENT,
  // NOTE: VITE_SENTRY_ENVIRONMENT must be defined in .env (with the VITE_
  // prefix) for this to read non-default. Server-side SENTRY_ENVIRONMENT is
  // not visible to the client bundle. Falls through to 'development' when
  // unset, which is the right default for local work.
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || 'development',
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      // Default privacy posture is aggressive (mask all text, block media);
      // RoamReady's UI doesn't show secrets, and replay value drops sharply
      // when everything is masked. Revisit if we ever surface PII in the
      // chrome (currently we don't — emails appear only on the Profile page).
      maskAllText: false,
      blockAllMedia: false,
    }),
  ],
  // 10% trace sampling matches the backend rate so end-to-end traces line up
  // when both sides happen to be sampled in the same request.
  tracesSampleRate: 0.1,
  // Replay sampling: don't record sessions that don't error (replays are
  // expensive in storage + bandwidth), but capture 100% of sessions where
  // an error did fire so we get the user-visible context for every reported
  // bug. This is Sentry's recommended baseline for production-bound apps.
  replaysSessionSampleRate: 0.0,
  replaysOnErrorSampleRate: 1.0,
  enabled: !!import.meta.env.VITE_SENTRY_DSN_CLIENT,
})
