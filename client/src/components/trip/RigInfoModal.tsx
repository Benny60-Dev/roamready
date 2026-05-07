import { useEffect, useState } from 'react'
import { X, Copy, Check, BadgeInfo } from 'lucide-react'
import { Rig, VehicleType } from '../../types'

const VEHICLE_LABELS: Record<VehicleType, string> = {
  RV_CLASS_A: 'Class A Motorhome',
  RV_CLASS_B: 'Class B / Camper Van',
  RV_CLASS_C: 'Class C Motorhome',
  FIFTH_WHEEL: 'Fifth Wheel',
  TRAVEL_TRAILER: 'Travel Trailer',
  TOY_HAULER: 'Toy Hauler',
  POP_UP: 'Pop-Up Camper',
  VAN: 'Converted Van',
  CAR_CAMPING: 'Car Camping',
}

interface Props {
  rig: Rig | null
  isOpen: boolean
  onClose: () => void
}

// Copy-to-clipboard button — shows a 2-second "Copied!" pulse on success.
// Stays a button (not a div) so the keyboard tab order stays sane in the
// modal. Falls back silently on browsers that block writeText.
function CopyPlateButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Best-effort copy. If the browser denies it, the user can still
      // long-press the value below to copy it manually.
    }
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[#1F6F8B] text-[#1F6F8B] hover:bg-[#1F6F8B]/5 transition-colors"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

// Recessed plate tile with copy button. Reused for the rig and (when towing)
// the towed unit.
function PlateTile({ label, plate }: { label: string; plate?: string | null }) {
  if (!plate) {
    return (
      <div className="rounded-lg bg-gray-50 p-3 mt-2">
        <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{label}</p>
        <p className="text-xs text-gray-400 italic">Not on file</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg bg-gray-50 p-3 mt-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{label}</p>
        <p
          className="text-base font-mono text-gray-900 truncate"
          style={{ letterSpacing: '0.08em' }}
        >
          {plate}
        </p>
      </div>
      <CopyPlateButton value={plate} />
    </div>
  )
}

export default function RigInfoModal({ rig, isOpen, onClose }: Props) {
  // ESC handler. Mirrors the ShareModal pattern; click-outside is wired on
  // the backdrop div below.
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rig-info-modal-title"
        className="bg-white rounded-xl w-full max-w-md overflow-hidden shadow-xl"
        style={{ borderWidth: '0.5px', borderStyle: 'solid', borderColor: '#E8E4DA' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <h2 id="rig-info-modal-title" className="font-medium text-gray-900 text-lg flex items-center gap-2">
              <BadgeInfo size={18} className="text-[#1F6F8B]" />
              My rig info
            </h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1 -mt-1 -mr-1 rounded-lg hover:bg-gray-100"
            >
              <X size={18} />
            </button>
          </div>

          {!rig ? (
            // Empty state when the user has no default rig on file. Don't
            // pretend we know anything — point them at the profile to fill it in.
            <div className="text-sm text-gray-500 leading-relaxed">
              <p>No rig info on file.</p>
              <p className="mt-2">
                <a
                  href="/profile/rig"
                  className="text-[#1F6F8B] hover:underline"
                >
                  Add one in your profile
                </a>{' '}
                to enable license-plate quick-copy at check-in.
              </p>
            </div>
          ) : (
            <>
              {/* Section 1 — the rig itself */}
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">
                  {VEHICLE_LABELS[rig.vehicleType]}
                </p>
                <p className="text-sm font-medium text-gray-900">
                  {[rig.year, rig.make, rig.model].filter(Boolean).join(' ') || 'Rig'}
                </p>

                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div className="rounded-lg bg-gray-50 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-gray-400">Length</p>
                    <p className="text-sm font-medium text-gray-900 mt-0.5">
                      {rig.length != null ? `${rig.length}ft` : '—'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-gray-400">Height</p>
                    <p className="text-sm font-medium text-gray-900 mt-0.5">
                      {rig.height != null ? `${rig.height}ft` : '—'}
                    </p>
                  </div>
                </div>

                <PlateTile label="License plate" plate={rig.licensePlate} />
              </div>

              {/* Section 2 — towing (only when active) */}
              {rig.isTowing && rig.towedType && (
                <div className="mt-5 pt-5 border-t border-gray-100">
                  <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">
                    {rig.towedType === 'VEHICLE' ? 'Towing — vehicle' : 'Towing — trailer'}
                  </p>
                  <p className="text-sm text-gray-900">
                    {rig.towedType === 'VEHICLE'
                      ? [rig.towedYear, rig.towedMake, rig.towedModel, rig.towedLength != null ? `${rig.towedLength}ft` : null]
                          .filter(Boolean)
                          .join(' · ')
                      : rig.towedLength != null
                        ? `${rig.towedLength}ft trailer`
                        : 'Trailer'}
                  </p>

                  <PlateTile label="License plate" plate={rig.towedLicensePlate} />
                </div>
              )}

              {/* Footer — open the edit page in a new tab so the booking
                  context isn't lost. Per the spec: target=_blank. */}
              <div className="mt-6 pt-4 border-t border-gray-100 flex justify-end">
                <a
                  href={`/profile/rig/${rig.id}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[#1F6F8B] hover:underline"
                >
                  Edit rig info
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
