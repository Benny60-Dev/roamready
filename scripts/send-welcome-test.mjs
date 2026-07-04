// One-off welcome-email test sender.
// Reads RESEND_API_KEY / FROM_EMAIL / REPLY_TO_EMAIL from the ROOT .env
// (never modifies it) and sends the draft welcome to a single recipient so
// Benny can see it in a real inbox. Standalone: no npm deps, uses Node's
// built-in fetch (Node 18+).
//
// Usage (from repo root):
//   node scripts/send-welcome-test.mjs                       -> sends to the default test address
//   node scripts/send-welcome-test.mjs you@example.com Benny -> override recipient + first name
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env')

// Minimal .env parser — just the keys we need, no dependency on dotenv.
function readEnv(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '')
  }
  return out
}

const env = readEnv(envPath)
const RESEND_API_KEY = env.RESEND_API_KEY
const FROM_EMAIL = env.FROM_EMAIL || 'onboarding@resend.dev'
const REPLY_TO = env.REPLY_TO_EMAIL || 'support@roamready.ai'

if (!RESEND_API_KEY) {
  console.error('RESEND_API_KEY not found in root .env — aborting.')
  process.exit(1)
}

const to = process.argv[2] || 'momann+expired1@gmail.com'
const firstName = process.argv[3] || 'Benny'

const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px">
    <p>Hi ${firstName},</p>
    <p>Welcome aboard &mdash; I'm glad you're here. RoamReady is built to take the stress out of planning RV and road trips, so you can spend less time wrestling logistics and more time actually out there.</p>
    <p>One thing I want you to know up front: <strong>this is a small operation and I read every email.</strong> If you have a question, hit a snag, or think of something RoamReady should do but doesn't yet &mdash; just reply to this message. Bug reports and feature ideas from real travelers are genuinely what shape what we build next.</p>
    <p>Wishing you good roads and clear skies,</p>
    <p style="margin-bottom:2px">&mdash; Benny</p>
    <p style="margin-top:0;color:#6b7280">Founder, RoamReady</p>
  </div>`.trim()

const text = `Hi ${firstName},

Welcome aboard — I'm glad you're here. RoamReady is built to take the stress out of planning RV and road trips, so you can spend less time wrestling logistics and more time actually out there.

One thing I want you to know up front: this is a small operation and I read every email. If you have a question, hit a snag, or think of something RoamReady should do but doesn't yet — just reply to this message. Bug reports and feature ideas from real travelers are genuinely what shape what we build next.

Wishing you good roads and clear skies,

— Benny
Founder, RoamReady`

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    from: `RoamReady <${FROM_EMAIL}>`,
    reply_to: REPLY_TO,
    to,
    subject: 'Welcome to RoamReady \u{1F3D5}\u{FE0F}',
    html,
    text,
  }),
})

const data = await res.json().catch(() => ({}))
if (res.ok) {
  console.log(`✓ Sent to ${to} (Resend id: ${data.id ?? 'n/a'})`)
} else {
  console.error(`✗ Resend returned HTTP ${res.status}:`, JSON.stringify(data, null, 2))
  process.exit(1)
}
