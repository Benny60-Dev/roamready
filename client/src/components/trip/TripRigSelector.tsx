import { useEffect, useState } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { Rig, Trip } from '../../types'
import { tripsApi } from '../../services/api'
import { rigDisplayName } from '../../utils/rigs'

interface RigSwapDeltas {
  length: number
  height: number
  weight: number
}

interface Props {
  tripId: string
  rigs: Rig[]
  /** The trip's current rigId, or null when it falls back to the profile default. */
  currentRigId: string | null
  /** Called with the freshly-refetched trip after a successful swap so the parent
   *  updates its trip state (fuel, fit, and the data-derived banner/labels refresh). */
  onSwapped: (freshTrip: Trip) => void
}

/** Round feet to at most 1 decimal; integers print clean ("5", not "5.0"). */
function ft(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/** Build the positive-only delta clause list for the larger-rig warning. */
function largerClauses(d: RigSwapDeltas): string {
  const parts: string[] = []
  if (d.length > 0) parts.push(`${ft(d.length)} ft longer`)
  if (d.height > 0) parts.push(`${ft(d.height)} ft taller`)
  if (d.weight > 0) parts.push(`${Math.round(d.weight).toLocaleString()} lb heavier`)
  if (parts.length <= 1) return parts.join('')
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
}

/**
 * RIG-CHANGE Phase 2 — "Rig for this trip" selector. Lists the user's profile
 * rigs plus a "Use profile default" option, swaps via PUT /trips/:id { rigId },
 * then refetches the trip so fuel/fit/labels refresh. A smaller-or-equal swap
 * applies quietly; a larger swap surfaces the post-swap warning built from the
 * server's rigSwap deltas (the swap already happened and is reversible by
 * reselecting the old rig — this is informational, not a block).
 */
export default function TripRigSelector({ tripId, rigs, currentRigId, onSwapped }: Props) {
  const resolveRig = (rigId: string | null): Rig | null =>
    (rigId ? rigs.find(r => r.id === rigId) : null) ?? rigs.find(r => r.isDefault) ?? null

  // The trip's EFFECTIVE current rig id: the explicit trip.rigId, else the profile
  // default rig (isDefault), else the first rig. A null trip.rigId ("uses the
  // profile default") is shown as the actual default rig's name — never a blank or
  // a "default" entry. DISPLAY only: the null-resolves-to-default concept used
  // everywhere else is untouched.
  const resolvedCurrentRigId = resolveRig(currentRigId)?.id ?? rigs[0]?.id ?? ''

  const [selected, setSelected] = useState<string>(resolvedCurrentRigId)
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState(false)
  const [warning, setWarning] = useState<{ newName: string; oldName: string; deltas: RigSwapDeltas } | null>(null)

  // Keep the dropdown synced to the effective current rig (after a swap, or once
  // rigs finish loading). Resyncing makes `dirty` go false again.
  useEffect(() => { setSelected(resolvedCurrentRigId) }, [resolvedCurrentRigId])

  // This control now only ever sends a REAL rig id (no "default"/null option), so
  // dirty is a plain id mismatch against the effective current rig.
  const dirty = selected !== '' && selected !== resolvedCurrentRigId

  const handleChange = async () => {
    if (!dirty || busy || !selected) return
    const newRigId = selected
    const oldRig = resolveRig(currentRigId)
    setBusy(true)
    setSuccess(false)
    setWarning(null)
    try {
      const res = await tripsApi.update(tripId, { rigId: newRigId })
      const swap = res.data?.rigSwap as { isLarger: boolean; deltas: RigSwapDeltas } | undefined
      // Refetch so fuel / fit / the data-derived banner + per-stop labels refresh.
      const fresh = await tripsApi.get(tripId)
      onSwapped(fresh.data)
      if (swap?.isLarger) {
        const newRig = resolveRig(newRigId)
        setWarning({
          newName: newRig ? rigDisplayName(newRig) : 'Your new rig',
          oldName: oldRig ? rigDisplayName(oldRig) : 'the previous rig',
          deltas: swap.deltas,
        })
      } else {
        setSuccess(true)
      }
    } catch (e) {
      console.error('[TripRigSelector] rig swap failed', e)
    } finally {
      setBusy(false)
    }
  }

  // Defensive: the parent only renders this when rigs.length > 0, but never
  // crash on an empty list — show a disabled "no rigs" state instead.
  if (rigs.length === 0) {
    return (
      <div className="mt-3 pt-3 border-t border-gray-100" style={{ borderTopWidth: '0.5px' }}>
        <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
          Rig for this trip
        </label>
        <p className="text-xs text-gray-400">No rigs on your profile.</p>
      </div>
    )
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100" style={{ borderTopWidth: '0.5px' }}>
      <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
        Rig for this trip
      </label>
      <div className="flex items-center gap-2">
        <select
          value={selected}
          onChange={e => { setSelected(e.target.value); setSuccess(false) }}
          className="flex-1 min-w-0 text-sm border border-gray-200 rounded-md px-2 py-2 bg-white text-gray-900 focus:outline-none focus:border-[#1F6F8B]"
        >
          {rigs.map(r => (
            <option key={r.id} value={r.id}>
              {rigDisplayName(r)}{r.length ? ` — ${r.length} ft` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleChange}
          disabled={!dirty || busy}
          className="text-sm font-medium px-3 py-2 rounded-md transition-colors flex-shrink-0 border border-[#1F6F8B] text-[#1F6F8B] bg-white hover:bg-[#E0F0F4] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
        >
          {busy ? 'Changing…' : 'Change'}
        </button>
      </div>

      {success && (
        <p className="mt-1.5 text-[11px] text-[#1F6F8B] flex items-center gap-1">
          <Check size={12} /> Rig updated
        </p>
      )}

      {warning && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
          <p className="text-[11px] font-semibold flex items-center gap-1 mb-0.5">
            <AlertTriangle size={12} /> Your new rig is larger
          </p>
          <p className="text-[11px] leading-snug">
            {warning.newName} is {largerClauses(warning.deltas)} than {warning.oldName}. Campground fit was checked against the old rig.
          </p>
        </div>
      )}
    </div>
  )
}
