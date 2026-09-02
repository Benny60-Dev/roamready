#!/usr/bin/env node
// REPLAY TOOL — re-run a captured planning conversation against the running
// dev API so an exact user-reported case becomes a repeatable test.
//
//   .\get-token.ps1                          (once per PowerShell window)
//   npm run replay -- server/replays/del-rio-nights.json
//   npm run replay -- server/replays/del-rio-nights.json --base http://localhost:3000 --verbose
//
// Sign-in, in order of preference:
//   1. $env:TOKEN (from get-token.ps1) — nothing else needed.
//   2. .replay.env in the repo root (gitignored, yours only):
//        REPLAY_EMAIL=momann@gmail.com
//        REPLAY_PASSWORD=...
//        REPLAY_BASE=http://localhost:3000     (optional; --base still wins)
//      The script logs in itself at the start of each run.
// Creates a FRESH planning session as that account, sends the file's user
// turns one at a time (exactly like SessionPage does: full history each call,
// then PUT the session so server-side state matches a real chat), prints the
// AI reply after each turn, then evaluates the file's `expect` checks.
//
// Real AI + Directions calls: a run costs a few cents. Never automatic.
//
// File shape (server/replays/*.json):
// {
//   "name": "del-rio-nights",
//   "source": { "sessionId": "...", "capturedAt": "2026-09-02", "note": "why this case matters" },
//   "setup": { "rigId": null, "note": "Mesa home, 6h cap, default rig" },
//   "turns": [
//     { "user": "Create a four stop trip to ...", "expect": { "noItinerary": true } },
//     { "user": "Do it in 2", "expect": { "noItinerary": true, "notRepeatOfPrev": true, "mustMention": ["hour|drive"] } }
//   ],
//   "final": { "builtNightsLteRequested": true, "minStops": 4 }
// }
// Turn checks: noItinerary | itinerary | notRepeatOfPrev | mustMention[regex] | mustNotMention[regex]
// Final checks: builtNightsLteRequested | builtNightsEq N | minStops N | maxStops N
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
if (!file) { console.error('usage: npm run replay -- <replay.json> [--base URL] [--verbose]'); process.exit(2) }
// .replay.env (repo root) — private login for unattended runs.
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.replay.env')
const renv = {}
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trim().startsWith('#')) renv[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const base = (args.includes('--base') ? args[args.indexOf('--base') + 1] : (renv.REPLAY_BASE || 'http://localhost:3000')).replace(/\/$/, '')
const verbose = args.includes('--verbose')
let token = process.env.TOKEN
if (!token && renv.REPLAY_EMAIL && renv.REPLAY_PASSWORD) {
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: renv.REPLAY_EMAIL, password: renv.REPLAY_PASSWORD }),
  })
  if (!r.ok) { console.error(`Login failed (${r.status}) for ${renv.REPLAY_EMAIL} at ${base} — check .replay.env`); process.exit(2) }
  token = (await r.json()).accessToken
  console.log(`signed in as ${renv.REPLAY_EMAIL} (${base})`)
}
if (!token) { console.error('No sign-in: run .\\get-token.ps1, or create .replay.env with REPLAY_EMAIL / REPLAY_PASSWORD (see header).'); process.exit(2) }

const replay = JSON.parse(readFileSync(resolve(file), 'utf8'))
const api = `${base}/api/v1`
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

async function call(method, path, body) {
  const r = await fetch(api + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
  return data
}

const stripItin = s => String(s ?? '').replace(/<itinerary>[\s\S]*?(<\/itinerary>|$)/g, '[itinerary]').trim()
const hasItin = s => /<itinerary>/.test(String(s ?? ''))
function parseItin(s) {
  const m = String(s ?? '').match(/<itinerary>([\s\S]*?)<\/itinerary>/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}
// Jaccard similarity on word sets — "the same canned sentence again" detector.
function similar(a, b) {
  const w = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean))
  const A = w(a), B = w(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

const results = []
const check = (label, ok, detail = '') => { results.push({ label, ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`) }

console.log(`\n=== Replay: ${replay.name} ===`)
if (replay.source?.note) console.log(`    ${replay.source.note}`)
const session = await call('POST', '/sessions', {})
console.log(`    session ${session.id} (${base})\n`)

const history = []
let prevReply = null
for (let i = 0; i < replay.turns.length; i++) {
  const turn = replay.turns[i]
  history.push({ role: 'user', content: turn.user })
  console.log(`--- turn ${i + 1} · USER: ${turn.user}`)
  const rig = replay.setup?.rigId ? { rigId: replay.setup.rigId } : {}
  const res = await call('POST', '/ai/chat', { messages: history, sessionId: session.id, ...rig })
  const reply = res.message ?? ''
  history.push({ role: 'assistant', content: reply })
  await call('PUT', `/sessions/${session.id}`, { messages: history })
  console.log(`    AI: ${verbose ? reply : stripItin(reply)}\n`)

  const e = turn.expect ?? {}
  if (e.noItinerary) check(`turn ${i + 1}: no itinerary built`, !hasItin(reply))
  if (e.itinerary) check(`turn ${i + 1}: itinerary built`, hasItin(reply))
  if (e.notRepeatOfPrev) {
    const sim = prevReply == null ? 0 : similar(stripItin(prevReply), stripItin(reply))
    check(`turn ${i + 1}: not a repeat of the previous reply`, sim < 0.8, `similarity ${sim.toFixed(2)}`)
  }
  for (const rx of e.mustMention ?? []) check(`turn ${i + 1}: mentions /${rx}/i`, new RegExp(rx, 'i').test(reply))
  for (const rx of e.mustNotMention ?? []) check(`turn ${i + 1}: does not mention /${rx}/i`, !new RegExp(rx, 'i').test(reply))
  prevReply = reply
}

// Final state: last emitted itinerary + the server-side partialTripData.
const finalSession = await call('GET', `/sessions/${session.id}`)
const ptd = finalSession.partialTripData ?? {}
const lastItin = [...history].reverse().map(m => parseItin(m.content)).find(Boolean) ?? null
const builtNights = lastItin ? lastItin.stops.reduce((n, s) => n + (s.type === 'OVERNIGHT_ONLY' ? 1 : (s.nights ?? 0)), 0) : null
const stops = lastItin ? lastItin.stops.filter(s => s.type !== 'HOME').length : null
console.log(`--- final: requestedNights=${ptd.requestedNights ?? '?'} builtNights=${builtNights ?? '-'} stops=${stops ?? '-'} driveCap=${ptd.driveCapHours ?? 'profile'}`)
const f = replay.final ?? {}
if (f.builtNightsLteRequested) check('final: built nights ≤ requested', builtNights == null || ptd.requestedNights == null || builtNights <= ptd.requestedNights, `${builtNights} vs ${ptd.requestedNights}`)
if (typeof f.builtNightsEq === 'number') check(`final: built nights = ${f.builtNightsEq}`, builtNights === f.builtNightsEq, `${builtNights}`)
if (typeof f.minStops === 'number') check(`final: ≥ ${f.minStops} stops`, stops != null && stops >= f.minStops, `${stops}`)
if (typeof f.maxStops === 'number') check(`final: ≤ ${f.maxStops} stops`, stops != null && stops <= f.maxStops, `${stops}`)

const failed = results.filter(r => !r.ok).length
console.log(`\n=== ${results.length - failed}/${results.length} checks passed ===\n`)
process.exit(failed ? 1 : 0)
