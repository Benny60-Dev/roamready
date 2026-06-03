import { useEffect, useRef, useState } from 'react'
import { Home as HomeIcon } from 'lucide-react'

/**
 * Save-home-address opt-in — fires once, right after a user promotes their
 * FIRST trip, when they have no saved home address yet (see SessionPage
 * buildItinerary). The trip is already fully built by the time this shows;
 * the modal only gates the hop to the trip map so the user can decide whether
 * to remember their starting location.
 *
 * EXPLICIT OPT-IN ONLY: the checkbox defaults to unchecked. We persist the
 * address to the user's profile (User.homeLocation/homeCity/homeState) ONLY
 * when the box is checked and the user confirms. Dismissing (Escape / backdrop
 * / "Continue" with the box unchecked) saves nothing and just proceeds to the
 * trip. This is deliberately the only place outside /profile that writes the
 * home fields, so a one-off per-trip starting point never overwrites a saved
 * home — that changes only when the user edits it on their profile page.
 */

interface Props {
  isOpen: boolean
  /** The resolved starting location, e.g. "Phoenix, AZ" — shown verbatim in the copy. */
  address: string
  isSaving?: boolean
  /** Called with the user's opt-in choice. true → save as home, false → skip. */
  onDone: (saveAsHome: boolean) => void
}

export default function SaveHomeAddressModal({ isOpen, address, isSaving = false, onDone }: Props) {
  const [saveAsHome, setSaveAsHome] = useState(false)
  const continueRef = useRef<HTMLButtonElement>(null)

  // Reset the opt-in every time the modal opens so a prior trip's choice never
  // bleeds into the next one, and focus the primary action.
  useEffect(() => {
    if (isOpen) {
      setSaveAsHome(false)
      continueRef.current?.focus()
    }
  }, [isOpen])

  // Escape dismisses without saving (unless a save is already in flight).
  // Mirrors the keyboard behavior of ConfirmVehiclesModal / ConfirmModal.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) onDone(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, isSaving, onDone])

  if (!isOpen) return null

  // Backdrop click dismisses without saving — matches ConfirmVehiclesModal.
  function onBackdropClick() {
    if (!isSaving) onDone(false)
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-home-title"
        className="bg-white rounded-lg border border-gray-200 w-full max-w-md p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-md bg-[#1F6F8B]/10 flex items-center justify-center flex-shrink-0">
            <HomeIcon size={16} className="text-[#1F6F8B]" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="save-home-title" className="font-semibold text-lg text-gray-900 mb-1">
              Starting from {address}?
            </h2>
            <p className="text-sm text-gray-600">
              If this is your home address, we'll save it to your profile so your next trip
              can start here automatically — no need to re-enter it. You can change it anytime
              in your profile.
            </p>
          </div>
        </div>

        <label className="flex items-center gap-2 mb-5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={saveAsHome}
            onChange={e => setSaveAsHome(e.target.checked)}
            disabled={isSaving}
            className="w-4 h-4 accent-[#1F6F8B] rounded border-gray-300"
          />
          <span className="text-sm text-gray-800">Save as my home address</span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            ref={continueRef}
            type="button"
            onClick={() => onDone(saveAsHome)}
            disabled={isSaving}
            className="bg-[#1F6F8B] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#134756] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
