import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { RigSafetyDim } from '../../utils/rigs'

/**
 * RIG-COMPLETENESS NOTICE (FR-RIGINFO) — non-blocking nudge shown on Build when
 * the user's SAVED rig is missing safety dims (height/length/weight) and/or MPG.
 * Explains what they'll miss, then offers "Add details" (go fill them in) or
 * "Build anyway" (proceed). Dismiss (backdrop / Esc / no choice) does NOT build —
 * it just closes and leaves the user on the planning page. Amber/warning styling
 * (a nudge, never a hard block). Shell mirrors ui/ConfirmModal.
 */

const DIM_LABELS: Record<RigSafetyDim, string> = {
  length: 'length',
  height: 'height',
  gvwr: 'weight',
}

/** Join friendly dim names: ["height","gvwr"] → "height and weight". */
function joinDims(dims: RigSafetyDim[]): string {
  const names = dims.map(d => DIM_LABELS[d])
  if (names.length <= 1) return names.join('')
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

export interface RigCompletenessNoticeProps {
  /** Missing safety dims among length/height/gvwr (empty = none missing). */
  missingDims: RigSafetyDim[]
  /** True when the rig has no MPG set. */
  missingMpg: boolean
  onAddDetails: () => void
  onBuildAnyway: () => void
  onClose: () => void
}

export default function RigCompletenessNotice({
  missingDims,
  missingMpg,
  onAddDetails,
  onBuildAnyway,
  onClose,
}: RigCompletenessNoticeProps) {
  const buildAnywayRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    buildAnywayRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const hasDims = missingDims.length > 0

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-lg border border-gray-200 w-full max-w-[420px] p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 mb-2">
          <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <h2 className="font-semibold text-lg text-gray-900">Add a few rig details?</h2>
        </div>

        <div className="text-sm text-gray-600 mb-6 leading-relaxed space-y-3">
          {hasDims && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2" style={{ borderWidth: '0.5px' }}>
              <p className="text-amber-800">
                Your rig is missing <span className="font-medium">{joinDims(missingDims)}</span> — you won't get
                low-bridge, tunnel, or weight-limit warnings on this trip.
              </p>
            </div>
          )}
          {missingMpg && (
            <p className={hasDims ? 'text-gray-500' : 'text-gray-600'}>
              Add your MPG for accurate fuel-cost estimates.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            ref={buildAnywayRef}
            onClick={onBuildAnyway}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            Build anyway
          </button>
          <button
            onClick={onAddDetails}
            className="bg-[#3E5540] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#2F4030] transition-colors"
          >
            Add details
          </button>
        </div>
      </div>
    </div>
  )
}
