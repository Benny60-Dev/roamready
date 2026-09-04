#!/usr/bin/env node
// REPLAY TOOL — re-run a captured planning conversation against the running
// dev API so an exact user-reported case becomes a repeatable test.
//
//   .\get-token.ps1                          (once per PowerShell window)
//   npm run replay -- server/replays/del-rio-nights.json
//   npm run replay -- server/replays/del-rio-nights.json --base http://localhost:3000 --verbose
//   npm run replay -- --case del-rio-nights          (FEAT-REPLAY-CASES: saved from the Session Inspector)
//   npm run replay -- --list                         (open + passing cases on the site)
//   npm run replay -- --case del-rio-nights --base https://roamready.ai   (run a saved case against prod)
//
// --case asks the SERVER on --base to run the saved case (the same runner as
// the admin page's ▶ Run button — services/replayRunner.ts), polls until it
// finishes, and prints the transcript + checks. The result is stored on the
// case (lastRun) so the admin Replay Cases page shows it. An OPEN case whose
// checks all pass flips to PASSING; a PASSING case that fails again reopens.
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
// Turn checks: noItinerary | itinerary | notRepeatOfPrev | mustMention[regex] | mustNotMention[regex] | statesWeekday "Friday"
//   npm run replay -- --push server/replays/<case>.json     (copy the file's turns/expect/final/note onto the SAVED case of the same name)
// Final checks: builtNightsLteRequested | builtNightsEq N | minStops N | maxStops N
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flagVal = f => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined)
const caseName = flagVal('--case')
const pushFile = flagVal('--push')
const listOnly = args.includes('--list')
const positional = args.filter((a, i) => !a.startsWith('--') && !['--base', '--case', '--push'].includes(args[i - 1]))
const file = positional[0]
if (!file && !caseName && !listOnly && !pushFile) { console.error('usage: npm run replay -- <replay.json> | --case <name> | --push <replay.json> | --list  [--base URL] [--verbose]'); process.exit(2) }
// Everything runs inside main() and returns an exit code — a bare process.exit()
// while a fetch handle is still closing trips a libuv assertion on Windows
// ("!(handle->flags & UV_HANDLE_CLOSING)"). exitCode lets Node drain first.
async function main() {
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
    if (!r.ok) { console.error(`Login failed (${r.status}) for ${renv.REPLAY_EMAIL} at ${base} — check .replay.env`); return 2 }
    token = (await r.json()).accessToken
    console.log(`signed in as ${renv.REPLAY_EMAIL} (${base})`)
  }
  if (!token) { console.error('No sign-in: run .\\get-token.ps1, or create .replay.env with REPLAY_EMAIL / REPLAY_PASSWORD (see header).'); return 2 }

  const api = `${base}/api/v1`
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  // --list: print the saved cases and stop (no AI calls).
  if (listOnly) {
    const r = await fetch(`${api}/admin/replay-cases`, { headers: H })
    if (!r.ok) { console.error(`GET /admin/replay-cases → ${r.status} (owner login required)`); return 2 }
    const rows = await r.json()
    if (!rows.length) { console.log('No saved replay cases.'); return 0 }
    for (const c of rows) {
      const lr = c.lastRunResult ? `${c.lastRunResult.passed}/${c.lastRunResult.total} on ${String(c.lastRunAt).slice(0, 10)}` : 'never run'
      console.log(`${c.status.padEnd(7)}  ${c.name.padEnd(32)}  ${c.turns.length} turns  last run ${lr}\n         ${c.note}`)
    }
    return 0
  }

  // --push: copy a file's turns / expect / final / note onto the saved case of
  // the same name — how checks get onto a saved case until the page can edit them.
  if (pushFile) {
    const f = JSON.parse(readFileSync(resolve(pushFile), 'utf8'))
    const r = await fetch(`${api}/admin/replay-cases/${encodeURIComponent(f.name)}`, { headers: H })
    if (r.status === 404) { console.error(`No saved case named "${f.name}" — save it from the Session Inspector first.`); return 2 }
    if (!r.ok) { console.error(`GET case → ${r.status}`); return 2 }
    const c = await r.json()
    const body = { turns: f.turns, final: f.final ?? {}, ...(f.source?.note ? { note: f.source.note } : {}) }
    const u = await fetch(`${api}/admin/replay-cases/${c.id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) })
    if (!u.ok) { console.error(`PATCH → ${u.status}: ${(await u.text()).slice(0, 300)}`); return 2 }
    const nChecks = f.turns.reduce((n, t) => n + Object.keys(t.expect ?? {}).length, 0) + Object.keys(f.final ?? {}).length
    console.log(`updated saved case "${f.name}": ${f.turns.length} turns, ${nChecks} checks. Run it: npm run replay -- --case ${f.name}`)
    return 0
  }

  // --case: ask the SERVER to run the saved case (services/replayRunner.ts) and
  // poll until it finishes — one runner, the same one the admin page's Run
  // button uses. The transcript + checks come back in lastRunResult.
  if (caseName) {
    const r = await fetch(`${api}/admin/replay-cases/${encodeURIComponent(caseName)}`, { headers: H })
    if (r.status === 404) { console.error(`No replay case "${caseName}" on ${base}. \`npm run replay -- --list\` shows what exists.`); return 2 }
    if (!r.ok) { console.error(`GET /admin/replay-cases/${caseName} → ${r.status} (owner login required)`); return 2 }
    const c = await r.json()
    console.log(`\n=== Replay case: ${c.name} (${c.status}) on ${base} ===\n    ${c.note}\n`)
    const start = await fetch(`${api}/admin/replay-cases/${c.id}/run`, { method: 'POST', headers: H })
    if (start.status === 409) console.log('    already running — attaching to that run')
    else if (!start.ok) { console.error(`POST run → ${start.status}: ${(await start.text()).slice(0, 300)}`); return 2 }
    let printed = 0, last = null
    for (;;) {
      await new Promise(res => setTimeout(res, 3000))
      const g = await fetch(`${api}/admin/replay-cases/${c.id}`, { headers: H })
      if (!g.ok) { console.error(`poll → ${g.status}`); return 2 }
      last = await g.json()
      const lr = last.lastRunResult ?? {}
      const tr = lr.transcript ?? []
      for (; printed < tr.length; printed++) {
        console.log(`--- turn ${printed + 1} · USER: ${tr[printed].user}`)
        console.log(`    AI: ${tr[printed].ai}\n`)
      }
      if (lr.status !== 'running') break
    }
    const lr = last.lastRunResult ?? {}
    if (lr.status === 'error') { console.error(`run failed: ${lr.error}`); return 1 }
    for (const k of lr.checks ?? []) console.log(`  ${k.ok ? 'PASS' : 'FAIL'}  ${k.label}${k.detail ? ' — ' + k.detail : ''}`)
    if (lr.final) console.log(`--- final: requestedNights=${lr.final.requestedNights ?? '?'} builtNights=${lr.final.builtNights ?? '-'} stops=${lr.final.stops ?? '-'} driveCap=${lr.final.driveCap ?? 'profile'}`)
    console.log(`\n=== ${lr.passed}/${lr.total} checks passed — status ${last.status}${lr.total === 0 ? ' (no expect checks yet — add some to make this a real test)' : ''} ===\n`)
    return lr.total > 0 && lr.passed < lr.total ? 1 : 0
  }

  const replay = JSON.parse(readFileSync(resolve(file), 'utf8'))

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
    if (typeof e.statesWeekday === 'string') {
      const m = reply.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i)
      const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
      const wd = m ? ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(Date.UTC(+m[3], months.indexOf(m[1].toLowerCase()), +m[2])).getUTCDay()] : null
      check(`turn ${i + 1}: stated date falls on a ${e.statesWeekday}`, wd != null && wd.toLowerCase() === e.statesWeekday.toLowerCase(), m ? `${m[0]} is a ${wd}` : 'no full date stated')
    }
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

  return failed ? 1 : 0
}

process.exitCode = await main()
