// AI-MESA-10 — multi-action modify pipeline: server-side parse authority +
// verified per-action apply state.
//
// Background (Cindy/Mesa incident, 2026-06-11): the model answered a
// multi-stop "route me home" ask with four <modify> blocks in one reply.
// The client parsed only the FIRST block (non-global regex) so stops 2-4
// silently vanished, and the persist path blanket-rewrote every block to
// the literal "[✓ change already applied]" — so reloaded history claimed
// four applies when one happened. Two rules fall out of that:
//
//   1. The SERVER parses all <modify> blocks into a structured actions[]
//      (each with a stable id) — the client never regexes prose again.
//   2. "Applied" is stamped ONLY by the trip-mutation endpoints at the
//      moment they actually execute an action (stampModifyActionApplied).
//      Nothing is ever marked applied at persist time, and the client's
//      word is never the source of truth.
//
// The persisted Trip.modifyConversation entry shape becomes:
//   { role, content, actions?: [{ id, action, applied, appliedAt }] }
// (plain {role, content} for user turns and tagless assistant turns —
// backward compatible with every existing consumer).
import { randomUUID } from 'crypto'
import { prisma } from '../utils/prisma'

export interface ParsedModifyAction {
  id: string
  /** The parsed JSON payload of one <modify> block (action, locationName, …). */
  action: Record<string, unknown>
}

export interface PersistedModifyAction extends ParsedModifyAction {
  applied: boolean
  appliedAt: string | null
}

export const MODIFY_BLOCK_RE = /<modify>([\s\S]*?)<\/modify>/g

/** Parse EVERY <modify> block in a model response, in emission order.
 *  Unparseable JSON is logged and skipped — the block still renders as
 *  stripped prose, it just can't become an applyable action. */
export function parseModifyBlocks(text: string): ParsedModifyAction[] {
  const out: ParsedModifyAction[] = []
  for (const m of text.matchAll(MODIFY_BLOCK_RE)) {
    try {
      out.push({ id: randomUUID(), action: JSON.parse(m[1].trim()) })
    } catch {
      console.warn('[modifyActions] unparseable <modify> block skipped:', m[1].slice(0, 120))
    }
  }
  return out
}

// ── Honesty guards ────────────────────────────────────────────────────────────

/** Deterministic display guard: bracketed applied/done markers are SYSTEM
 *  namespace — the model must never be able to assert an apply. Strips
 *  "[✓ change already applied]" and close variants ("[applied]",
 *  "[✓ applied]", "[change applied to trip]", …) from model output before
 *  it reaches the client or persistence. Scoped to bracketed tokens so
 *  legitimate prose is never touched. */
const APPLIED_CLAIM_RE = /\[[^\]\n]{0,80}applied[^\]\n]{0,80}\]/gi
export function stripAppliedClaims(text: string): string {
  return text.replace(APPLIED_CLAIM_RE, '').replace(/[ \t]{2,}/g, ' ').trim()
}

/** Pre-MESA-10 histories contain the old blanket marker, written at persist
 *  time with no knowledge of whether the user ever clicked Apply. We cannot
 *  verify those retroactively → degrade to neutral wording, never a false
 *  checkmark. Applied when SERVING history (getModifyHistory), not stored. */
const LEGACY_APPLIED_MARKER_RE = /\[✓ change already applied\]/g
export const NEUTRAL_LEGACY_MARKER =
  '[change proposed in an earlier conversation — apply status unknown]'
export function neutralizeLegacyMarkers(text: string): string {
  return text.replace(LEGACY_APPLIED_MARKER_RE, NEUTRAL_LEGACY_MARKER)
}

// ── Model-bound history annotation (state-aware) ─────────────────────────────

/** Stable key for matching a <modify> payload against stored actions.
 *  Postgres jsonb does not preserve key order, so sort keys deep before
 *  stringifying — the same payload always yields the same key regardless
 *  of which side of a DB round-trip it came from. */
export function actionKey(action: unknown): string {
  const sortDeep = (v: any): any =>
    Array.isArray(v)
      ? v.map(sortDeep)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])]))
        : v
  return JSON.stringify(sortDeep(action))
}

/** Set of actionKey()s for every APPLIED action in a stored conversation. */
export function buildAppliedLookup(conversation: unknown): Set<string> {
  const applied = new Set<string>()
  if (!Array.isArray(conversation)) return applied
  for (const entry of conversation) {
    if (!entry || !Array.isArray((entry as any).actions)) continue
    for (const a of (entry as any).actions) {
      if (a?.applied === true && a?.action) applied.add(actionKey(a.action))
    }
  }
  return applied
}

/** Replaces each <modify> block in a model-bound assistant turn with a
 *  TRUTHFUL state marker. The old annotateAppliedModify stamped everything
 *  "[✓ change already applied]" — teaching the model that proposals
 *  auto-apply (and that the marker is normal assistant text). Now the model
 *  sees exactly what happened. Legacy blanket markers in old text are
 *  neutralized for the same reason. */
export function annotateForModel(content: string, isApplied: (action: unknown) => boolean): string {
  return neutralizeLegacyMarkers(content)
    .replace(MODIFY_BLOCK_RE, (_match, inner: string) => {
      try {
        return isApplied(JSON.parse(inner.trim()))
          ? '[✓ applied — the user clicked Apply and this change is in the itinerary]'
          : '[proposal — NOT applied; the user has not clicked Apply on this change]'
      } catch {
        return '[proposal — NOT applied; the user has not clicked Apply on this change]'
      }
    })
    .trim()
}

// ── Verified apply stamping ───────────────────────────────────────────────────

/** Marks one persisted action applied=true. Called by the trip-mutation
 *  endpoints (createStop / updateStop / deleteStop / shiftTripDates) AFTER
 *  their mutation succeeds — execution and stamp travel together, so the
 *  client never self-reports success. Never throws: the mutation already
 *  succeeded, a stamp failure is metadata loss and is logged loudly.
 *  Callers have already ownership-verified tripId. */
export async function stampModifyActionApplied(
  tripId: string,
  actionId: string | undefined,
): Promise<void> {
  if (!actionId) return
  try {
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: { modifyConversation: true },
    })
    const conv = trip?.modifyConversation
    if (!Array.isArray(conv)) {
      console.warn('[modifyActions] stamp: no modifyConversation on trip %s (actionId=%s)', tripId, actionId)
      return
    }
    let found = false
    const next = (conv as any[]).map(entry => {
      if (!entry || !Array.isArray(entry.actions)) return entry
      return {
        ...entry,
        actions: entry.actions.map((a: any) => {
          if (a?.id !== actionId) return a
          found = true
          return { ...a, applied: true, appliedAt: new Date().toISOString() }
        }),
      }
    })
    if (!found) {
      console.warn('[modifyActions] stamp: actionId %s not found on trip %s', actionId, tripId)
      return
    }
    await prisma.trip.update({ where: { id: tripId }, data: { modifyConversation: next } })
    console.log('[modifyActions] stamped applied=true actionId=%s trip=%s', actionId, tripId)
  } catch (err: any) {
    console.error('[modifyActions] stamp failed (mutation unaffected): %s', err?.message ?? err)
  }
}
