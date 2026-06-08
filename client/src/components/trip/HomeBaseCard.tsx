import { useState } from 'react'
import { Home as HomeIcon } from 'lucide-react'
import AddressAutocomplete, { type HomeAddress } from '../ui/AddressAutocomplete'
import { usersApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'

/**
 * Option-2 first-trip "Add your home base" inline card (style A).
 *
 * Mounts in the empty-state planning hero, ABOVE the hero ChatInput, ONLY for a
 * no-home user who hasn't built any trip yet — the gate (showHomeCard) lives in
 * SessionPage. Reuses AddressAutocomplete (Google Places, 8-field capture) +
 * usersApi.updateMe — the IDENTICAL write Profile (ProfilePage.onSubmit) and the
 * post-build SaveHomeAddressModal use.
 *
 * SELF-TERMINATING: a successful save sets user.homeLocation via setUser, which
 * flips the parent gate false and unmounts this card — no explicit hide needed.
 * Skip is a local-state dismiss handled by the parent (onSkip); the data-derived
 * gate makes it self-terminating (no migration, no session flag).
 *
 * COMMIT MODEL: the autocomplete onPlace CAPTURES the picked 8-field address into
 * local state (it does not save on select); the gold "Save home base" button
 * commits it. This mirrors SaveHomeAddressModal's "pick then confirm" flow and
 * gives the explicit Save button a real purpose.
 */
interface Props {
  /** Skip — parent hides the card for this session (local state). */
  onSkip: () => void
}

export default function HomeBaseCard({ onSkip }: Props) {
  const { user, setUser } = useAuthStore()
  // The selected place's 8 fields; null until the user picks from the dropdown.
  // Gates the Save button (can't save nothing) and is what we persist.
  const [picked, setPicked] = useState<HomeAddress | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSaveHome(addr: HomeAddress) {
    setSaving(true)
    setError(null)
    try {
      const res = await usersApi.updateMe(addr)
      // Mirror ProfilePage.onSubmit / handleSaveHomeDone: merge the server's
      // canonical updated user. This sets user.homeLocation, so the parent's
      // showHomeCard gate goes false and the card unmounts.
      setUser({ ...user!, ...res.data })
    } catch (e: any) {
      console.error('[HomeBaseCard] save failed:', e?.message)
      setError('Could not save your home base. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="bg-white rounded-xl mb-3"
      style={{ border: '0.5px solid #1F6F8B', padding: '14px 16px' }}
    >
      <div className="flex items-start gap-2.5 mb-3">
        <HomeIcon size={16} className="flex-shrink-0 mt-0.5" color="#1F6F8B" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium text-[#134756] text-sm">Add your home base</p>
          <p className="text-[#6B6458] mt-0.5" style={{ fontSize: 13 }}>
            Save where you usually roll out from, and we'll route every trip from there automatically.
          </p>
        </div>
      </div>

      <AddressAutocomplete
        placeholder="Start typing your city or address…"
        onPlace={setPicked}
        disabled={saving}
      />

      {picked && (picked.homeCity || picked.homeState) && (
        <p className="text-xs text-[#1F6F8B] mt-1.5">
          {[picked.homeCity, picked.homeState].filter(Boolean).join(', ')}
          {picked.homeZip ? ` ${picked.homeZip}` : ''}
        </p>
      )}

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          className="btn-primary flex-1 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={!picked || saving}
          onClick={() => picked && handleSaveHome(picked)}
        >
          {saving ? 'Saving…' : 'Save home base'}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-sm font-medium text-[#6B6458] border border-[#E8E4DA] hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          Skip
        </button>
      </div>

      <p className="text-center text-[#888780] mt-2.5" style={{ fontSize: 12 }}>
        No fixed home? Skip — we'll just ask per trip.
      </p>
    </div>
  )
}
