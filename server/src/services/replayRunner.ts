import jwt from 'jsonwebtoken'
import { prisma } from '../utils/prisma'

// FEAT-REPLAY-RUN — the server runs a saved ReplayCase itself, so the admin
// Replay Cases page (and `npm run replay -- --case`) get a one-click run with
// live progress and a saved transcript. Mirrors scripts/replay-session.mjs:
// fresh planning session as the OWNER who clicked Run, the case's user turns
// sent one at a time exactly like SessionPage (full history each call, then
// PUT the session), per-turn + final checks evaluated, result written to
// ReplayCase.lastRunResult. Calls go over loopback HTTP with a short-lived
// token minted for that owner, so every gate / rate limit / audit path is the
// real one. Real AI + Directions calls — cents per run; one run at a time.

type Turn = { user: string; expect?: Record<string, unknown> }
type Check = { label: string; ok: boolean; detail?: string }
export type RunResult = {
  status: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  base: string
  turn?: number          // turns completed so far (progress while running)
  turns?: number         // total user turns
  sessionId?: string
  passed: number
  total: number
  failed: string[]
  checks?: Check[]
  transcript?: { user: string; ai: string }[]
  final?: Record<string, unknown>
  error?: string
  runBy?: string
}

const running = new Set<string>()
export const isRunning = (caseId: string) => running.has(caseId)

const rc = () => (prisma as any).replayCase

// ── check helpers (verbatim from the script) ─────────────────────────────────
const stripItin = (s: unknown) => String(s ?? '').replace(/<itinerary>[\s\S]*?(<\/itinerary>|$)/g, '[itinerary]').trim()
const hasItin = (s: unknown) => /<itinerary>/.test(String(s ?? ''))
function parseItin(s: unknown): any | null {
  const m = String(s ?? '').match(/<itinerary>([\s\S]*?)<\/itinerary>/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}
function similar(a: unknown, b: unknown): number {
  const w = (s: unknown) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean))
  const A = w(a), B = w(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

// statesWeekday check (BUG-THIS-FRIDAY): the FIRST fully-stated date in the
// reply ("September 6th, 2026") must fall on the named weekday. Date-agnostic,
// so the case stays valid whenever it is re-run.
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december']
export function firstStatedDate(text: string): { raw: string; weekday: string } | null {
  const m = String(text ?? '').match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2])))
  return { raw: m[0], weekday: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()] }
}

// Status lifecycle shared with the PATCH path: OPEN → PASSING when ≥1 check and
// all pass; PASSING → OPEN on a regression; FIXED is Benny's and never auto-moves.
export function nextStatusAfterRun(current: string, passed: number, total: number): string | undefined {
  const allPassed = total > 0 && passed === total
  if (allPassed && current === 'OPEN') return 'PASSING'
  if (!allPassed && total > 0 && current === 'PASSING') return 'OPEN'
  return undefined
}

async function save(caseId: string, result: RunResult, status?: string) {
  await rc().update({
    where: { id: caseId },
    data: { lastRunAt: new Date(result.startedAt), lastRunResult: result, ...(status ? { status } : {}) },
  })
}

// Kick off a run. Returns immediately; progress lands in lastRunResult.
// Throws if this case is already running.
export async function startReplayRun(caseId: string, owner: { id: string; email: string }): Promise<RunResult> {
  if (running.has(caseId)) throw new Error('already running')
  const row = await rc().findUnique({ where: { id: caseId } })
  if (!row) throw new Error('not found')
  const turns: Turn[] = Array.isArray(row.turns) ? row.turns : []
  const port = process.env.PORT || 3001
  const base = `http://127.0.0.1:${port}`
  const result: RunResult = {
    status: 'running', startedAt: new Date().toISOString(), base: 'server', turn: 0, turns: turns.length,
    passed: 0, total: 0, failed: [], checks: [], transcript: [], runBy: owner.email,
  }
  running.add(caseId)
  await save(caseId, result)
  console.info('[replay-run] %s started by %s (%d turns)', row.name, owner.email, turns.length)

  // Fire and forget — the request that started it has already answered.
  void (async () => {
    const token = jwt.sign({ userId: owner.id, replayRunner: true }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const api = `${base}/api/v1`
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    async function call(method: string, path: string, body?: unknown) {
      const r = await fetch(api + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
      const text = await r.text()
      let data: any = null
      try { data = text ? JSON.parse(text) : null } catch { data = text }
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`)
      return data
    }
    const checks: Check[] = []
    const check = (label: string, ok: boolean, detail = '') => { checks.push({ label, ok, detail }) }
    try {
      const session = await call('POST', '/sessions', {})
      result.sessionId = session.id
      const history: { role: string; content: string }[] = []
      let prevReply: string | null = null
      const setup: any = row.setup ?? {}
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]
        history.push({ role: 'user', content: turn.user })
        const rig = setup.rigId ? { rigId: setup.rigId } : {}
        const res = await call('POST', '/ai/chat', { messages: history, sessionId: session.id, ...rig })
        const reply: string = res.message ?? ''
        history.push({ role: 'assistant', content: reply })
        await call('PUT', `/sessions/${session.id}`, { messages: history })
        result.transcript!.push({ user: turn.user, ai: stripItin(reply) })

        const e: any = turn.expect ?? {}
        if (e.noItinerary) check(`turn ${i + 1}: no itinerary built`, !hasItin(reply))
        if (e.itinerary) check(`turn ${i + 1}: itinerary built`, hasItin(reply))
        if (e.notRepeatOfPrev) {
          const sim = prevReply == null ? 0 : similar(stripItin(prevReply), stripItin(reply))
          check(`turn ${i + 1}: not a repeat of the previous reply`, sim < 0.8, `similarity ${sim.toFixed(2)}`)
        }
        for (const rx of e.mustMention ?? []) check(`turn ${i + 1}: mentions /${rx}/i`, new RegExp(rx, 'i').test(reply))
        for (const rx of e.mustNotMention ?? []) check(`turn ${i + 1}: does not mention /${rx}/i`, !new RegExp(rx, 'i').test(reply))
        if (typeof e.statesWeekday === 'string') {
          const d = firstStatedDate(reply)
          check(`turn ${i + 1}: stated date falls on a ${e.statesWeekday}`, !!d && d.weekday.toLowerCase() === e.statesWeekday.toLowerCase(), d ? `${d.raw} is a ${d.weekday}` : 'no full date stated')
        }
        prevReply = reply

        result.turn = i + 1
        result.checks = checks
        result.passed = checks.filter(c => c.ok).length
        result.total = checks.length
        result.failed = checks.filter(c => !c.ok).map(c => c.label)
        await save(caseId, result)
      }

      const finalSession = await call('GET', `/sessions/${session.id}`)
      const ptd: any = finalSession.partialTripData ?? {}
      const lastItin = [...history].reverse().map(m => parseItin(m.content)).find(Boolean) ?? null
      const builtNights: number | null = lastItin ? lastItin.stops.reduce((n: number, s: any) => n + (s.type === 'OVERNIGHT_ONLY' ? 1 : (s.nights ?? 0)), 0) : null
      const stops: number | null = lastItin ? lastItin.stops.filter((s: any) => s.type !== 'HOME').length : null
      result.final = { requestedNights: ptd.requestedNights ?? null, builtNights, stops, driveCap: ptd.driveCapHours ?? 'profile' }
      const f: any = row.final ?? {}
      if (f.builtNightsLteRequested) check('final: built nights ≤ requested', builtNights == null || ptd.requestedNights == null || builtNights <= ptd.requestedNights, `${builtNights} vs ${ptd.requestedNights}`)
      if (typeof f.builtNightsEq === 'number') check(`final: built nights = ${f.builtNightsEq}`, builtNights === f.builtNightsEq, `${builtNights}`)
      if (typeof f.minStops === 'number') check(`final: ≥ ${f.minStops} stops`, stops != null && stops >= f.minStops, `${stops}`)
      if (typeof f.maxStops === 'number') check(`final: ≤ ${f.maxStops} stops`, stops != null && stops <= f.maxStops, `${stops}`)

      result.status = 'done'
      result.finishedAt = new Date().toISOString()
      result.checks = checks
      result.passed = checks.filter(c => c.ok).length
      result.total = checks.length
      result.failed = checks.filter(c => !c.ok).map(c => c.label)
      const fresh = await rc().findUnique({ where: { id: caseId }, select: { status: true } })
      await save(caseId, result, nextStatusAfterRun(fresh?.status ?? row.status, result.passed, result.total))
      console.info('[replay-run] %s done: %d/%d', row.name, result.passed, result.total)
    } catch (err: any) {
      result.status = 'error'
      result.finishedAt = new Date().toISOString()
      result.error = String(err?.message ?? err).slice(0, 500)
      await save(caseId, result).catch(() => {})
      console.error('[replay-run] %s failed: %s', row.name, result.error)
    } finally {
      running.delete(caseId)
    }
  })()

  return result
}
