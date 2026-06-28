import { useEffect, useRef, useState } from 'react'

export interface RvSafetyAckModalProps {
  isOpen: boolean
  /** Proceed with the build. Only reachable once the required box is checked. */
  onConfirm: () => void
  /** Abort the build. */
  onCancel: () => void
  /** True while the build is in flight (after confirm) — disables the controls. */
  isConfirming?: boolean
}

/**
 * RV-SAFETY-ACK — blocking acknowledgment shown at Build Itinerary time, BEFORE
 * any trip/stop is created. The user must check the box and click the proceed
 * button to continue; Cancel aborts the build. The acknowledgment is persisted
 * once per trip (see SessionPage.buildItinerary → tripsApi.acknowledgeRvSafety)
 * after the build's stop loop completes, and is reset whenever a later modify
 * changes the route (server-side, syncTripEndpoints).
 *
 * Styling mirrors ui/ConfirmModal for consistency.
 */
export default function RvSafetyAckModal({
  isOpen,
  onConfirm,
  onCancel,
  isConfirming = false,
}: RvSafetyAckModalProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const [checked, setChecked] = useState(false)

  // Reset the checkbox each time the modal (re)opens so a prior acknowledgment
  // never carries over into a fresh build click.
  useEffect(() => {
    if (isOpen) setChecked(false)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    cancelButtonRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isConfirming) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, isConfirming, onCancel])

  if (!isOpen) return null

  const handleBackdropClick = () => {
    if (!isConfirming) onCancel()
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-lg border border-gray-200 w-full max-w-[440px] p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="font-semibold text-lg text-gray-900 mb-2">
          Before we build your trip
        </h2>

        {/* ============================================================ */}
        {/* PLACEHOLDER COPY — Benny will supply the final, legal-approved */}
        {/* wording. Swap the contents of this block only; the checkbox /  */}
        {/* button behavior below should not need to change.               */}
        {/* ============================================================ */}
        <div className="text-sm text-gray-600 mb-4 leading-relaxed space-y-3">
          <p>
            RoamReady has <strong>not</strong> verified that the destinations and
            routes in this trip are safe for your RV. We do not confirm bridge or
            tunnel clearances, weight or length limits, road grades, or any other
            vehicle restriction along the way.
          </p>
          <p>
            <strong>
              You are responsible for independently verifying clearance, weight,
              length, and grade
            </strong>{' '}
            for your specific rig before and during travel. Always check official
            road signs and authoritative sources.
          </p>
        </div>
        {/* ===================== END PLACEHOLDER COPY ===================== */}

        <label className="flex items-start gap-2 mb-6 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={checked}
            disabled={isConfirming}
            onChange={e => setChecked(e.target.checked)}
            className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[#3E5540] cursor-pointer disabled:cursor-not-allowed"
          />
          <span className="text-sm text-gray-700 leading-relaxed">
            I understand RoamReady does not verify RV safety, and I’m responsible
            for checking clearance, weight, length, and grade myself.
          </span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            ref={cancelButtonRef}
            onClick={onCancel}
            disabled={isConfirming}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!checked || isConfirming}
            className="bg-[#3E5540] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#2F4030] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isConfirming ? 'Building…' : 'I understand — build my trip'}
          </button>
        </div>
      </div>
    </div>
  )
}
