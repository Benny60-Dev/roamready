import { useEffect, useMemo, useState } from 'react'
import { journalApi, visitedStatesApi } from '../../services/api'
import type { JournalEntry, Trip } from '../../types'
import { deriveTripStatus } from '../../utils/tripStatus'
import { normalizeStateCode, STATE_CODES, type StateTier, type StateMeta } from './stateUtils'

/**
 * Shared visited-states rollup. Extracted verbatim from JournalTabContent so the
 * Dashboard Journal Maps banner and the Home discovery card derive the exact same
 * numbers from the exact same rule set. Pure function — no I/O, no React.
 *
 *   DERIVED (date-derived via deriveTripStatus, NOT the stale stored Trip.status):
 *     overnight   = completed-trip stops (non-HOME, nights >= 1)
 *     passthrough = completed-trip stops with nights === 0, PLUS journal entries
 *                   with a state — minus any already overnight
 *   MANUAL marks fold in with the locked rule: derived-overnight is authoritative
 *   (a manual mark on such a state is IGNORED); otherwise overnight wins over
 *   passthrough in the final merge.
 *   visitedCount = (finalOvernight ∪ finalPassthrough), excluding DC, of 50.
 */
export interface ManualStateMark {
  state: string
  visitType: string
}

export interface VisitedStates {
  overnight: Set<string>
  passthrough: Set<string>
  visitedCount: number
  stateMeta: Map<string, StateMeta>
}

export function deriveVisitedStates(
  trips: Trip[],
  entries: JournalEntry[],
  manualStates: ManualStateMark[],
): VisitedStates {
  // Derived sets.
  const derivedOvernight = new Set<string>()
  const derivedPassthrough = new Set<string>()
  for (const trip of trips) {
    if (deriveTripStatus(trip) !== 'COMPLETED') continue
    for (const stop of trip.stops || []) {
      if (stop.type === 'HOME') continue
      const code = normalizeStateCode(stop.locationState)
      if (!code) continue
      if (stop.nights >= 1) derivedOvernight.add(code)
      else derivedPassthrough.add(code)
    }
  }
  for (const e of entries) {
    const code = normalizeStateCode(e.state)
    if (code) derivedPassthrough.add(code)
  }
  for (const code of derivedOvernight) derivedPassthrough.delete(code)

  // Raw manual marks (kept for the editor's display, independent of the lock).
  const rawManual = new Map<string, StateTier>()
  for (const m of manualStates) {
    const code = normalizeStateCode(m.state)
    if (!code) continue
    rawManual.set(code, m.visitType === 'overnight' ? 'overnight' : 'passthrough')
  }

  // Apply manual marks with the lock rule, then resolve overnight-wins.
  const finalOvernight = new Set<string>(derivedOvernight)
  const finalPassthrough = new Set<string>(derivedPassthrough)
  for (const [code, tier] of rawManual) {
    if (derivedOvernight.has(code)) continue // locked — manual can't downgrade
    if (tier === 'overnight') finalOvernight.add(code)
    else finalPassthrough.add(code)
  }
  for (const code of finalOvernight) finalPassthrough.delete(code) // overnight wins

  // Counter is over the 50 states — DC is shown on the map but doesn't count.
  const union = new Set<string>([...finalOvernight, ...finalPassthrough])
  union.delete('DC')

  // Per-state metadata for the editor.
  const meta = new Map<string, StateMeta>()
  for (const code of STATE_CODES) {
    meta.set(code, {
      derivedTier: derivedOvernight.has(code)
        ? 'overnight'
        : derivedPassthrough.has(code)
          ? 'passthrough'
          : 'none',
      manualTier: rawManual.get(code) ?? 'none',
      locked: derivedOvernight.has(code),
    })
  }

  return {
    overnight: finalOvernight,
    passthrough: finalPassthrough,
    visitedCount: union.size,
    stateMeta: meta,
  }
}

/**
 * Fetches the journal entries + manual state marks a caller needs to derive the
 * visited-states rollup, and returns the rollup for the passed-in `trips`. Used
 * by the Home discovery card (SessionPage), which already has trips in hand but
 * not entries/manual marks. Both fetches fail soft — the map falls back to
 * trips-derived only, exactly like the Dashboard's non-fatal manual-state fetch.
 */
export function useVisitedStates(trips: Trip[]): VisitedStates & { loading: boolean } {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [manualStates, setManualStates] = useState<ManualStateMark[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([journalApi.list(), visitedStatesApi.list()])
      .then(([entriesRes, manualRes]) => {
        if (cancelled) return
        if (entriesRes.status === 'fulfilled') setEntries(entriesRes.value.data)
        if (manualRes.status === 'fulfilled') setManualStates(manualRes.value.data)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const derived = useMemo(
    () => deriveVisitedStates(trips, entries, manualStates),
    [trips, entries, manualStates],
  )

  return { ...derived, loading }
}
