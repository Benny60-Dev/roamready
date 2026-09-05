import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, Trash2, Play, Loader2 } from 'lucide-react'
import { adminApi } from '../../services/api'
import { CopyForSupport } from '../../components/admin/Copy'

// FEAT-REPLAY-CASES — owner-only list of saved planner regression cases.
// A case is a real conversation (user turns only) saved from the Session
// Inspector with a "what went wrong" note. It is run from the repo with
// `npm run replay -- --case <name>`; the script writes lastRun back here.
// Status: OPEN → PASSING (auto, when every check passes) → FIXED (Benny).

type CaseStatus = 'OPEN' | 'PASSING' | 'FIXED'
interface ReplayTurn { user: string; expect?: Record<string, unknown> }
interface ReplayCase {
  id: string
  name: string
  status: CaseStatus
  note: string
  sourceSessionId: string | null
  sourceUserEmail: string | null
  setup: Record<string, unknown>
  turns: ReplayTurn[]
  final: Record<string, unknown> | null
  createdByEmail: string | null
  lastRunAt: string | null
  lastRunResult: RunResult | null
  createdAt: string
}

// Mirrors server/src/services/replayRunner.ts RunResult.
interface RunResult {
  status?: 'running' | 'done' | 'error'
  startedAt?: string
  finishedAt?: string
  base?: string
  turn?: number
  turns?: number
  sessionId?: string
  passed: number
  total: number
  failed?: string[]
  checks?: { label: string; ok: boolean; detail?: string }[]
  transcript?: { user: string; ai: string }[]
  final?: Record<string, unknown>
  error?: string
  runBy?: string
}

const STATUS_CLASS: Record<CaseStatus, string> = {
  OPEN: 'bg-red-50 text-red-700',
  PASSING: 'bg-amber-50 text-amber-700',
  FIXED: 'bg-emerald-50 text-emerald-700',
}
const fmt = (iso?: string | null) => {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return String(iso) }
}

// "Send to Claude" — a ready-to-paste handoff: what the case is, what Benny
// said went wrong, and the last run's checks/transcript so Claude can start
// the scout without re-fetching anything. Pasted into the Claude chat.
function claudeHandoff(c: ReplayCase): string {
  const lr = c.lastRunResult
  const lines: string[] = [
    `Please inspect and repair replay case "${c.name}" (status ${c.status}).`,
    `What went wrong: ${c.note}`,
    c.setup?.note ? `Setup: ${c.setup.note}` : '',
    c.sourceSessionId ? `Source session: ${c.sourceSessionId}${c.sourceUserEmail ? ` (${c.sourceUserEmail})` : ''}` : '',
    '',
    'User turns:',
    ...c.turns.map((t, i) => `${i + 1}. ${t.user}${t.expect && Object.keys(t.expect).length ? `   expect ${JSON.stringify(t.expect)}` : ''}`),
  ]
  if (lr && lr.status !== 'running') {
    lines.push('', `Last run (${fmt(c.lastRunAt)}): ${lr.status === 'error' ? `FAILED — ${lr.error}` : `${lr.passed}/${lr.total} checks`}`)
    for (const k of lr.checks ?? []) lines.push(`  ${k.ok ? 'PASS' : 'FAIL'}  ${k.label}${k.detail ? ' — ' + k.detail : ''}`)
    if (lr.final) {
      lines.push(`  final: requested ${String(lr.final.requestedNights ?? '?')} nights, built ${String(lr.final.builtNights ?? '-')} nights, ${String(lr.final.stops ?? '-')} stops, drive cap ${String(lr.final.driveCap ?? 'profile')}`)
      if (lr.final.builtStops) lines.push(`  built stops: ${String(lr.final.builtStops)}`)
      const df: any = lr.final.driveFacts
      if (df) lines.push(`  drive facts given to the planner: ${df.miles} mi, ${df.driveHours} h, cap ${df.capHours} h, min ${df.minNights} nights, road-night towns: ${df.roadNightTowns}`)
    }
    if (lr.transcript?.length) {
      lines.push('', 'Transcript:')
      for (const [i, t] of lr.transcript.entries()) lines.push(`${i + 1}. USER: ${t.user}`, `   AI: ${t.ai}`)
    }
  }
  lines.push('', 'Add expect checks that define correct behaviour, fix the cause on a branch, re-run until it passes, and tell me what changed.')
  return lines.filter(l => l !== undefined).join('\n')
}

// The case as the replay file the script understands — for "Copy JSON" when
// someone wants to hand-edit expect checks in a file instead.
function caseJson(c: ReplayCase): string {
  return JSON.stringify({
    name: c.name,
    source: { sessionId: c.sourceSessionId, userEmail: c.sourceUserEmail, capturedAt: c.createdAt.slice(0, 10), note: c.note },
    setup: c.setup,
    turns: c.turns,
    final: c.final ?? {},
  }, null, 2)
}

export default function AdminReplayCasesPage() {
  const [cases, setCases] = useState<ReplayCase[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'ALL' | CaseStatus>('ALL')
  const [openId, setOpenId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const res = await adminApi.listReplayCases()
      setCases(Array.isArray(res.data) ? res.data : [])
    } catch { setError('Could not load replay cases.') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  // While any case is running, poll every 3s so the row shows live progress.
  const anyRunning = cases.some(c => c.lastRunResult?.status === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [anyRunning])

  // ▶ Run — the server replays the case (real AI calls, cents per run).
  async function run(c: ReplayCase) {
    setBusyId(c.id); setError(null)
    try {
      const res = await adminApi.runReplayCase(c.id)
      setCases(cs => cs.map(x => x.id === c.id ? { ...x, ...res.data } : x))
      setOpenId(c.id)
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.response?.data?.message ?? 'Could not start the run.')
    } finally { setBusyId(null) }
  }

  async function setStatus(c: ReplayCase, status: CaseStatus) {
    if (status === c.status) return
    setBusyId(c.id); setError(null)
    try {
      const res = await adminApi.updateReplayCase(c.id, { status })
      setCases(cs => cs.map(x => x.id === c.id ? { ...x, ...res.data } : x))
    } catch { setError('Could not update the case.') }
    finally { setBusyId(null) }
  }

  // Deletion is confirm-gated in-page (no window.confirm — it blocks the tab).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  async function remove(c: ReplayCase) {
    setBusyId(c.id); setError(null)
    try {
      await adminApi.deleteReplayCase(c.id)
      setCases(cs => cs.filter(x => x.id !== c.id))
      if (openId === c.id) setOpenId(null)
    } catch { setError('Could not delete the case.') }
    finally { setBusyId(null); setConfirmDeleteId(null) }
  }

  const shown = cases.filter(c => filter === 'ALL' || c.status === filter)
  const counts = { OPEN: 0, PASSING: 0, FIXED: 0 } as Record<CaseStatus, number>
  for (const c of cases) counts[c.status]++

  return (
    <div className="space-y-6 max-w-5xl">
      <Breadcrumb items={[{ label: 'Admin Dashboard' }, { label: 'Replay Cases' }]} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium text-gray-900">Replay Cases</h1>
          <p className="text-sm text-gray-500 mt-1">
            Real conversations saved from the <Link to="/admin/session-inspector" className="text-[#1F6F8B] hover:underline">Session Inspector</Link> and re-run against the planner. <span className="font-medium text-gray-700">Run</span> replays a case right here as your account (real AI calls — a few cents each); the same run is available from the repo with <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">npm run replay -- --case &lt;name&gt;</code>.
          </p>
        </div>
        <div className="flex gap-1.5">
          {(['ALL', 'OPEN', 'PASSING', 'FIXED'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`text-xs px-2.5 py-1 rounded-full border ${filter === f ? 'bg-[#1F6F8B] text-white border-[#1F6F8B]' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}
            >
              {f === 'ALL' ? `All ${cases.length}` : `${f.charAt(0) + f.slice(1).toLowerCase()} ${counts[f]}`}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="card bg-red-50 border-red-100 text-sm text-red-700 flex items-center gap-2"><AlertTriangle size={14} /> {error}</div>
      )}

      {loading ? (
        <div className="card h-24 animate-pulse bg-gray-50" />
      ) : shown.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-700 text-sm font-medium mb-1">{cases.length === 0 ? 'No replay cases yet.' : 'Nothing in this filter.'}</p>
          <p className="text-gray-500 text-sm">Open a session in the Session Inspector and click <span className="font-medium">Save as replay case</span>.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map(c => {
            const open = openId === c.id
            const lr = c.lastRunResult
            const isRunning = lr?.status === 'running'
            const lastOk = lr ? lr.total > 0 && lr.passed === lr.total : null
            return (
              <div key={c.id} className="card p-0 overflow-hidden">
                <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : c.id)}
                  className="flex-1 min-w-0 text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50"
                >
                  <span className="mt-0.5 text-gray-400">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-sm font-medium text-gray-900">{c.name}</code>
                      <span className={`badge text-xs ${STATUS_CLASS[c.status]}`}>{c.status.charAt(0) + c.status.slice(1).toLowerCase()}</span>
                      <span className="text-xs text-gray-400">{c.turns.length} turn{c.turns.length === 1 ? '' : 's'}</span>
                      {c.sourceUserEmail && <span className="text-xs text-gray-400 truncate">{c.sourceUserEmail}</span>}
                    </div>
                    <p className="text-sm text-gray-700 mt-1 line-clamp-2">{c.note}</p>
                  </div>
                  <div className="text-right text-xs text-gray-500 flex-shrink-0">
                    <p>Saved {fmt(c.createdAt)}</p>
                    {isRunning ? (
                      <p className="flex items-center justify-end gap-1 text-[#1F6F8B]">
                        <Loader2 size={12} className="animate-spin" /> Running… turn {lr?.turn ?? 0} of {lr?.turns ?? c.turns.length}
                      </p>
                    ) : lr?.status === 'error' ? (
                      <p className="flex items-center justify-end gap-1 text-red-600"><AlertTriangle size={12} /> run failed · {fmt(c.lastRunAt)}</p>
                    ) : lr ? (
                      <p className={`flex items-center justify-end gap-1 ${lr.total === 0 ? 'text-gray-500' : lastOk ? 'text-emerald-600' : 'text-red-600'}`}>
                        {lr.total === 0 ? null : lastOk ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />} {lr.total === 0 ? 'ran, no checks' : `${lr.passed}/${lr.total}`} · {fmt(c.lastRunAt)}
                      </p>
                    ) : <p className="text-gray-400">never run</p>}
                  </div>
                </button>
                {/* ▶ Run lives outside the expand button so clicking it never toggles the row. */}
                <div className="flex items-center pr-4 pl-1">
                  <button
                    type="button"
                    onClick={() => run(c)}
                    disabled={isRunning || busyId === c.id}
                    title={isRunning ? 'Already running' : 'Run this case now (real AI calls — a few cents)'}
                    className="btn-primary text-xs flex items-center gap-1.5 flex-shrink-0 disabled:opacity-50"
                  >
                    {isRunning ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {isRunning ? 'Running' : 'Run'}
                  </button>
                </div>
                </div>

                {open && (
                  <div className="border-t border-gray-100 px-4 py-3 space-y-3 bg-gray-50/60">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-gray-400">Status</span>
                      {(['OPEN', 'PASSING', 'FIXED'] as CaseStatus[]).map(s => (
                        <button
                          key={s}
                          type="button"
                          disabled={busyId === c.id}
                          onClick={() => setStatus(c, s)}
                          className={`text-xs px-2 py-0.5 rounded-full border ${c.status === s ? STATUS_CLASS[s] + ' border-transparent font-medium' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'}`}
                        >
                          {s.charAt(0) + s.slice(1).toLowerCase()}
                        </button>
                      ))}
                      <span className="flex-1" />
                      <CopyForSupport text={`npm run replay -- --case ${c.name}`} label="Copy command" />
                      <CopyForSupport text={caseJson(c)} label="Copy JSON" />
                      {c.sourceSessionId && (
                        <Link to={`/admin/session-inspector?sessionId=${encodeURIComponent(c.sourceSessionId)}`} className="btn-outline text-xs">Open session</Link>
                      )}
                      {confirmDeleteId === c.id ? (
                        <span className="flex items-center gap-1 text-xs">
                          <span className="text-gray-600">Delete this case?</span>
                          <button type="button" onClick={() => remove(c)} disabled={busyId === c.id} className="text-red-600 font-medium hover:underline">Yes, delete</button>
                          <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-gray-500 hover:underline">No</button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setConfirmDeleteId(c.id)} title="Delete case" className="text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>
                      )}
                    </div>

                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-gray-400">What went wrong</p>
                      <p className="text-sm text-gray-800 whitespace-pre-wrap">{c.note}</p>
                    </div>
                    {typeof c.setup?.note === 'string' && c.setup.note && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-gray-400">Setup</p>
                        <p className="text-sm text-gray-700">{c.setup.note}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-gray-400">User turns</p>
                      <ol className="mt-1 space-y-1">
                        {c.turns.map((t, i) => (
                          <li key={i} className="text-sm text-gray-800 flex gap-2">
                            <span className="text-gray-400 w-5 flex-shrink-0 text-right">{i + 1}.</span>
                            <span className="min-w-0">
                              {t.user}
                              {t.expect && Object.keys(t.expect).length > 0 && (
                                <code className="ml-2 text-[11px] text-gray-500">{JSON.stringify(t.expect)}</code>
                              )}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                    {lr && (
                      <div className="border-t border-gray-200 pt-3 space-y-3">
                        <p className="text-[10px] uppercase tracking-wide text-gray-400">
                          Last run — {isRunning ? 'in progress' : lr.status === 'error' ? 'failed' : 'finished'} · started {fmt(lr.startedAt ?? c.lastRunAt)}{lr.runBy ? ` by ${lr.runBy}` : ''}{lr.base && lr.base !== 'server' ? ` (${lr.base})` : ''}
                        </p>
                        {lr.error && <p className="text-sm text-red-700">{lr.error}</p>}
                        {lr.checks && lr.checks.length > 0 ? (
                          <ul className="space-y-0.5">
                            {lr.checks.map((k, i) => (
                              <li key={i} className={`text-sm ${k.ok ? 'text-emerald-700' : 'text-red-700'}`}>{k.ok ? '✓' : '✗'} {k.label}{k.detail ? <span className="text-gray-500"> — {k.detail}</span> : null}</li>
                            ))}
                          </ul>
                        ) : lr.failed && lr.failed.length > 0 ? (
                          <ul className="space-y-0.5">{lr.failed.map((f, i) => <li key={i} className="text-sm text-red-700">✗ {f}</li>)}</ul>
                        ) : !isRunning && lr.status !== 'error' ? (
                          <p className="text-sm text-gray-500">No <code>expect</code> checks on this case yet — it replayed and recorded the replies below, but nothing was judged.</p>
                        ) : null}
                        {lr.final && (
                          <div className="text-xs text-gray-500 space-y-0.5">
                            <p>Final: requested {String(lr.final.requestedNights ?? '?')} nights · built {String(lr.final.builtNights ?? '-')} nights · {String(lr.final.stops ?? '-')} stops · drive cap {String(lr.final.driveCap ?? 'profile')}</p>
                            {lr.final.builtStops ? <p>Built: {String(lr.final.builtStops)}</p> : null}
                            {(lr.final as any).driveFacts ? <p>Facts given to the planner: {(lr.final as any).driveFacts.miles} mi · {(lr.final as any).driveFacts.driveHours} h · cap {(lr.final as any).driveFacts.capHours} h · min {(lr.final as any).driveFacts.minNights} nights · road nights at {(lr.final as any).driveFacts.roadNightTowns}</p> : null}
                          </div>
                        )}
                        {lr.transcript && lr.transcript.length > 0 && (
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-gray-400">Transcript</p>
                            <ol className="mt-1 space-y-2">
                              {lr.transcript.map((t, i) => (
                                <li key={i} className="text-sm">
                                  <p className="text-gray-900"><span className="text-gray-400 mr-1">{i + 1}.</span><span className="font-medium">You:</span> {t.user}</p>
                                  <p className="text-gray-700 whitespace-pre-wrap pl-5"><span className="font-medium text-[#1F6F8B]">AI:</span> {t.ai}</p>
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}
                        {lr.sessionId && (
                          <Link to={`/admin/session-inspector?sessionId=${encodeURIComponent(lr.sessionId)}`} className="text-xs text-[#1F6F8B] hover:underline">Open the run's session in the inspector →</Link>
                        )}
                        {/* Send to Claude only once a run has finished — the handoff
                            carries this run's transcript + checks. Run → look → send. */}
                        {lr.status === 'done' && (
                          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-200">
                            <CopyForSupport text={claudeHandoff(c)} label="Send to Claude" primary />
                            <span className="text-xs text-gray-500">Copies this case + run as a handoff — paste it into the Claude chat and say go.</span>
                          </div>
                        )}
                      </div>
                    )}
                    <p className="text-[11px] text-gray-400">
                      Source session {c.sourceSessionId ?? '—'} · saved by {c.createdByEmail ?? '—'}. Checks (<code>expect</code>) are edited via Copy JSON → file for now.
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
