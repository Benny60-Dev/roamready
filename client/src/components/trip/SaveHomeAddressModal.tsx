import { useEffect, useRef, useState } from 'react'
import { Home as HomeIcon, MapPin } from 'lucide-react'
import AddressAutocomplete, { type HomeAddress } from '../ui/AddressAutocomplete'

/**
 * Save-home-address opt-in — fires once, right after a user promotes their
 * FIRST trip, when they have no saved home address yet (see SessionPage
 * buildItinerary). The trip is already fully built by the time this shows;
 * the modal only gates the hop to the trip map so the user can decide whether
 * to remember their home address.
 *
 * STRUCTURED CAPTURE (PROF-2): the modal embeds a Google Places autocomplete
 * pre-seeded with the trip's start city. The user picks their REAL street
 * address from the dropdown, which captures all 8 home fields (street, city,
 * state, zip, lat/lng, formatted) into local state — no more thin city-centroid
 * record relying on a server geocode backfill.
 *
 * EXPLICIT OPT-IN ONLY: the "Save as my home address" checkbox defaults to
 * unchecked AND stays disabled until a real place has been selected from the
 * dropdown. We persist to the user's profile ONLY when the box is checked and
 * the user confirms — at which point onDone(true, address) carries the full
 * 8-field object. Dismissing (Escape / backdrop / "Not now") calls
 * onDone(false) with no address: nothing is saved and we just proceed to the
 * trip (whose start city still drives planning). Two clean paths, no muddy
 * city-centroid middle. This is deliberately the only place outside /profile
 * that writes the home fields.
 */

interface Props {
  isOpen: boolean
  /** The resolved starting location, e.g. "Phoenix, AZ" — seeds the input. */
  address: string
  isSaving?: boolean
  /**
   * Called with the user's opt-in choice.
   * - (true, address) → save the full 8-field address as home.
   * - (false)         → skip; save nothing.
   */
  onDone: (saveAsHome: boolean, address?: HomeAddress) => void
}

export default function SaveHomeAddressModal({ isOpen, address, isSaving = false, onDone }: Props) {
  const [saveAsHome, setSaveAsHome] = useState(false)
  // The selected place's 8 fields. null until the user picks from the dropdown;
  // gates both the checkbox (can't opt in to nothing) and what we hand back.
  const [picked, setPicked] = useState<HomeAddress | null>(null)
  const continueRef = useRef<HTMLButtonElement>(null)

  // Reset state every time the modal opens so a prior trip's choice/selection
  // never bleeds into the next one, and focus the primary action.
  useEffect(() => {
    if (isOpen) {
      setSaveAsHome(false)
      setPicked(null)
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

  function onConfirm() {
    if (saveAsHome && picked) onDone(true, picked)
    else onDone(false)
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
              If this is your home, pick your address below and we'll save it to your profile so
              your next trip can start here automatically — no need to re-enter it. You can change
              it anytime in your profile.
            </p>
          </div>
        </div>

        <div className="mb-4">
          <label className="label">Home address</label>
          <AddressAutocomplete
            defaultValue={address}
            disabled={isSaving}
            onPlace={addr => {
              setPicked(addr)
              setSaveAsHome(true) // surface the captured address as opted-in by default
            }}
          />
          {picked && (picked.homeCity || picked.homeState) && (
            <p className="mt-1.5 flex items-center gap-1 text-xs text-[#1F6F8B]">
              <MapPin size={11} />
              {[picked.homeCity, picked.homeState].filter(Boolean).join(', ')}
              {picked.homeZip ? ` ${picked.homeZip}` : ''}
            </p>
          )}
        </div>

        <label className={`flex items-center gap-2 mb-5 select-none ${picked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
          <input
            type="checkbox"
            checked={saveAsHome}
            onChange={e => setSaveAsHome(e.target.checked)}
            disabled={isSaving || !picked}
            className="w-4 h-4 accent-[#1F6F8B] rounded border-gray-300"
          />
          <span className="text-sm text-gray-800">Save as my home address</span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDone(false)}
            disabled={isSaving}
            className="px-4 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            Not now
          </button>
          <button
            ref={continueRef}
            type="button"
            onClick={onConfirm}
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
