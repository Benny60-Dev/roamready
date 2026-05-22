import { useEffect, useRef, useState } from 'react'
import { Car, Truck, Home as HomeIcon, Plus, X, Check } from 'lucide-react'
import { Rig } from '../../types'
import { VEHICLE_LABELS } from '../../pages/profile/RigPage'
import { deriveSecondVehicle } from '../../utils/rigs'

/**
 * Confirm-vehicles modal — fires at trip-promote time (after the AI emits an
 * <itinerary>, before sessionsApi.promote creates the Trip row).
 *
 * Captures the per-trip vehicle decisions:
 *   - Rig is ALWAYS included — never a question.
 *   - Required tow vehicle (deriveSecondVehicle.direction === 'tow_vehicle')
 *     is ALSO always included — the trailer can't move without it.
 *   - Optional toad (direction === 'toad') gets a Yes/No question. Default Yes.
 *   - "+ Add a different vehicle for this trip" reveals a small inline form
 *     that populates a per-trip ad-hoc vehicle — NOT saved to the profile.
 *
 * The modal is the canvas's only intervention between "user clicks Build full
 * itinerary" and "the Trip row exists in the DB." If the user has no rig at
 * all, SessionPage skips the modal entirely (see onBuildItineraryClick) — the
 * fallback path is the pre-Block-8 promote behavior.
 */

export interface AdHocVehicle {
  year?: number
  make?: string
  model?: string
  length?: number
}

export interface ConfirmVehiclesResult {
  bringingTowed: boolean | null
  adHocVehicle: AdHocVehicle | null
}

interface Props {
  isOpen: boolean
  rig: Rig
  onConfirm: (result: ConfirmVehiclesResult) => void
  onCancel: () => void
  isConfirming?: boolean
}

export default function ConfirmVehiclesModal({
  isOpen,
  rig,
  onConfirm,
  onCancel,
  isConfirming = false,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const { direction, required } = deriveSecondVehicle(rig.vehicleType)

  // Default to bringing the toad — matches the modal's primary-button selection.
  // null is reserved for "not asked" (the modal didn't fire, e.g. no rig).
  const [bringingTowed, setBringingTowed] = useState(true)

  // Ad-hoc vehicle form — hidden behind the "+ Add" link.
  const [adHocOpen, setAdHocOpen] = useState(false)
  const [adHocYear, setAdHocYear] = useState('')
  const [adHocMake, setAdHocMake] = useState('')
  const [adHocModel, setAdHocModel] = useState('')
  const [adHocLength, setAdHocLength] = useState('')

  // Reset transient state every time the modal opens, so a previous cancel
  // doesn't bleed an old ad-hoc form into the next session.
  useEffect(() => {
    if (isOpen) {
      setBringingTowed(true)
      setAdHocOpen(false)
      setAdHocYear('')
      setAdHocMake('')
      setAdHocModel('')
      setAdHocLength('')
      cancelRef.current?.focus()
    }
  }, [isOpen])

  // Escape closes the modal (unless the promote call is in flight). Matches
  // ConfirmModal's keyboard behavior elsewhere in the app.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isConfirming) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, isConfirming, onCancel])

  if (!isOpen) return null

  // Backdrop click cancels — matches ConfirmModal.
  function onBackdropClick() {
    if (!isConfirming) onCancel()
  }

  function handleConfirm() {
    // Build adHocVehicle: only include it if user opened the form AND filled
    // at least one field. An expanded-but-empty form yields null so the trip
    // record stays clean.
    let adHocVehicle: AdHocVehicle | null = null
    if (adHocOpen) {
      const parsed: AdHocVehicle = {}
      if (adHocYear.trim()) {
        const y = parseInt(adHocYear.trim(), 10)
        if (!isNaN(y)) parsed.year = y
      }
      if (adHocMake.trim()) parsed.make = adHocMake.trim()
      if (adHocModel.trim()) parsed.model = adHocModel.trim()
      if (adHocLength.trim()) {
        const l = parseFloat(adHocLength.trim())
        if (!isNaN(l)) parsed.length = l
      }
      if (Object.keys(parsed).length > 0) adHocVehicle = parsed
    }

    onConfirm({
      // Only send bringingTowed when the question was actually asked
      // (toad direction). Tow-vehicle/none directions leave it null so the
      // Trip row records "not asked" rather than a false answer.
      bringingTowed: direction === 'toad' ? bringingTowed : null,
      adHocVehicle,
    })
  }

  const rigName = [rig.year, rig.make, rig.model].filter(Boolean).join(' ') || VEHICLE_LABELS[rig.vehicleType]
  const towedName = [rig.towedYear, rig.towedMake, rig.towedModel].filter(Boolean).join(' ') ||
    (rig.towedType === 'TRAILER' ? 'Trailer' : 'Vehicle')

  // Whether to render the second-vehicle row at all:
  //   - tow_vehicle direction: only if the user actually filled in tow-vehicle
  //     data (rig.isTowing + a name/length). If they haven't, we still don't
  //     ask in this modal — that's a profile-completeness nudge that lives on
  //     the rig card, not here.
  //   - toad direction: only if the rig has saved toad data (the user opted in
  //     to towing via the optional radio on the rig form).
  //   - none: no second-vehicle row.
  const hasSecondVehicleData =
    rig.isTowing &&
    !!(rig.towedYear || rig.towedMake || rig.towedModel || rig.towedLength)
  const showSecondVehicleRow = direction !== 'none' && hasSecondVehicleData

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-vehicles-title"
        className="bg-white rounded-lg border border-gray-200 w-full max-w-md p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="confirm-vehicles-title" className="font-semibold text-lg text-gray-900 mb-1">
          Your vehicles for this trip
        </h2>
        <p className="text-xs text-gray-500 mb-5">
          Confirm what you're bringing — the rig is locked in; the second vehicle depends on your setup.
        </p>

        {/* ── Rig row (always included) ────────────────────────────────── */}
        <div className="border border-gray-200 rounded-lg p-3 mb-2" style={{ borderWidth: '0.5px' }}>
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-md bg-gray-50 flex items-center justify-center flex-shrink-0">
              <HomeIcon size={16} className="text-[#1F6F8B]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-gray-900 truncate">{rigName}</p>
                <span className="badge-completed text-xs">Included</span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {VEHICLE_LABELS[rig.vehicleType]}
                {rig.length ? ` · ${rig.length}ft` : ''}
                {' · always on the trip'}
              </p>
            </div>
          </div>
        </div>

        {/* ── Second-vehicle row (direction-dependent) ─────────────────── */}
        {showSecondVehicleRow && (
          <div className="border border-gray-200 rounded-lg p-3 mb-2" style={{ borderWidth: '0.5px' }}>
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-md bg-gray-50 flex items-center justify-center flex-shrink-0">
                {direction === 'tow_vehicle' ? (
                  <Truck size={16} className="text-[#1F6F8B]" />
                ) : (
                  <Car size={16} className="text-[#1F6F8B]" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                {direction === 'tow_vehicle' && (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-gray-900 truncate">{towedName}</p>
                      <span className="badge-completed text-xs">Included</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Tow vehicle
                      {rig.towedLength ? ` · ${rig.towedLength}ft` : ''}
                      {' · the rig can’t move without it'}
                    </p>
                  </>
                )}
                {direction === 'toad' && (
                  <>
                    <p className="text-sm font-medium text-gray-900 truncate">{towedName}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Are you bringing the {towedName}?
                    </p>
                    {/* Yes/No buttons. Default selection (Yes) sits on the
                        left so the most-common choice gets the eye first. */}
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <button
                        type="button"
                        onClick={() => setBringingTowed(true)}
                        aria-pressed={bringingTowed}
                        className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          bringingTowed
                            ? 'bg-[#1F6F8B] text-white'
                            : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
                        }`}
                        style={{ borderWidth: bringingTowed ? undefined : '0.5px' }}
                      >
                        <Check size={12} /> Yes, towing it
                      </button>
                      <button
                        type="button"
                        onClick={() => setBringingTowed(false)}
                        aria-pressed={!bringingTowed}
                        className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          !bringingTowed
                            ? 'bg-[#1F6F8B] text-white'
                            : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
                        }`}
                        style={{ borderWidth: !bringingTowed ? undefined : '0.5px' }}
                      >
                        <X size={12} /> No, leaving it home
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Ad-hoc vehicle (one-off, trip-only) ──────────────────────── */}
        {!adHocOpen ? (
          <button
            type="button"
            onClick={() => setAdHocOpen(true)}
            className="w-full text-center py-2 text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors flex items-center justify-center gap-1"
          >
            <Plus size={13} /> Add a different vehicle for this trip
          </button>
        ) : (
          <div className="border border-dashed border-gray-300 rounded-lg p-3 mb-2 bg-gray-50/40" style={{ borderWidth: '0.5px' }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-gray-700">One-off vehicle</p>
              <button
                type="button"
                onClick={() => { setAdHocOpen(false); setAdHocYear(''); setAdHocMake(''); setAdHocModel(''); setAdHocLength('') }}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Remove
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mb-2 italic">
              Just for this trip — not saved to your profile.
            </p>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <input className="input text-xs" placeholder="Year" type="number" value={adHocYear} onChange={e => setAdHocYear(e.target.value)} />
              <input className="input text-xs" placeholder="Make" value={adHocMake} onChange={e => setAdHocMake(e.target.value)} />
              <input className="input text-xs" placeholder="Model" value={adHocModel} onChange={e => setAdHocModel(e.target.value)} />
            </div>
            <div>
              <input className="input text-xs" placeholder="Length (ft)" type="number" step="0.1" value={adHocLength} onChange={e => setAdHocLength(e.target.value)} />
            </div>
          </div>
        )}

        {/* ── Action buttons ───────────────────────────────────────────── */}
        <div className="flex justify-end gap-2 mt-5">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={isConfirming}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isConfirming}
            className="bg-[#1F6F8B] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#134756] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isConfirming ? 'Building…' : 'Confirm and build →'}
          </button>
        </div>

        {/* Note: required is referenced via deriveSecondVehicle's contract for
            Block 8's UX decisions even though we don't display it directly —
            tow_vehicle's "Included" copy implicitly conveys requiredness. */}
        {!showSecondVehicleRow && direction !== 'none' && !required && null}
      </div>
    </div>
  )
}
