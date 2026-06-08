import { useState } from 'react'
import { Home as HomeIcon } from 'lucide-react'
import AddressAutocomplete, { type HomeAddress } from '../ui/AddressAutocomplete'
import { usersApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'

/**
 * "Add your home base" inline card (mockup B) — shown in the empty-state planning
 * hero for a user with no saved home, no full-timer flag, and no prior dismiss
 * (gate lives in SessionPage). Segmented:
 *   • "I have a home base" → AddressAutocomplete (Google Places, 8-field) →
 *     "Save home base" → usersApi.updateMe(HomeAddress) (identical write to
 *     Profile / SaveHomeAddressModal).
 *   • "I'm a full-timer"   → no address field → "Done" → updateMe({ isFullTimeRVer:true }).
 *   • "Skip"               → updateMe({ dismissedHomePrompt:true }), show a one-time
 *     "add it in Profile" line, then dismiss.
 *
 * SELF-TERMINATING: saving a home / Done / Skip all set a user flag (homeLocation,
 * isFullTimeRVer, or dismissedHomePrompt) via setUser, which flips the parent gate
 * false and unmounts the card. Skip briefly shows the confirmation line first.
 */
interface Props {
  /** Skip — parent hides the card for this session (local state). */
  onSkip: () => void
}

export default function HomeBaseCard({ onSkip }: Props) {
  const { user, setUser } = useAuthStore()
  const [mode, setMode] = useState<'home' | 'fulltimer'>('home')
  // The selected place's 8 fields; null until the user picks from the dropdown.
  const [picked, setPicked] = useState<HomeAddress | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // After Skip we briefly show a confirmation line before the card is removed.
  const [skipped, setSkipped] = useState(false)

  async function handleSaveHome(addr: HomeAddress) {
    setSaving(true)
    setError(null)
    try {
      const res = await usersApi.updateMe(addr)
      setUser({ ...user!, ...res.data })   // sets homeLocation → parent gate flips → unmount
    } catch (e: any) {
      console.error('[HomeBaseCard] save home failed:', e?.message)
      setError('Could not save your home base. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDone() {
    setSaving(true)
    setError(null)
    try {
      const res = await usersApi.updateMe({ isFullTimeRVer: true })
      setUser({ ...user!, ...res.data, isFullTimeRVer: true })  // gate flips → unmount
    } catch (e: any) {
      console.error('[HomeBaseCard] full-timer save failed:', e?.message)
      setError('Could not save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  function handleSkip() {
    setSkipped(true)   // show the confirmation line immediately
    // Persist the dismiss best-effort so it stays hidden on future sessions.
    usersApi.updateMe({ dismissedHomePrompt: true })
      .catch((e: any) => console.error('[HomeBaseCard] skip persist failed:', e?.message))
    // Brief confirmation, then flip the gate + remove the card.
    setTimeout(() => {
      setUser({ ...user!, dismissedHomePrompt: true })
      onSkip()
    }, 2200)
  }

  // Post-skip confirmation line (shown briefly before the card is removed).
  if (skipped) {
    return (
      <div
        className="bg-white rounded-xl mb-3 text-center text-[#6B6458]"
        style={{ border: '0.5px solid #1F6F8B', padding: '14px 16px', fontSize: 13 }}
      >
        You can add a home base anytime in your Profile.
      </div>
    )
  }

  const segBtn = (active: boolean) =>
    `flex-1 py-1.5 text-sm font-medium transition-colors ${active ? 'bg-[#1F6F8B] text-white' : 'bg-white text-[#6B6458] hover:bg-gray-50'}`

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

      {/* Segmented mode toggle */}
      <div className="flex rounded-lg border border-[#E8E4DA] overflow-hidden mb-3">
        <button type="button" onClick={() => setMode('home')} disabled={saving} className={segBtn(mode === 'home')}>
          I have a home base
        </button>
        <button type="button" onClick={() => setMode('fulltimer')} disabled={saving} className={segBtn(mode === 'fulltimer')}>
          I'm a full-timer
        </button>
      </div>

      {mode === 'home' ? (
        <>
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
        </>
      ) : (
        <p className="text-[#6B6458]" style={{ fontSize: 13 }}>
          No fixed home base — we'll just ask where you're starting from on each trip.
        </p>
      )}

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      <div className="flex items-center gap-2 mt-3">
        {mode === 'home' ? (
          <button
            type="button"
            className="btn-primary flex-1 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!picked || saving}
            onClick={() => picked && handleSaveHome(picked)}
          >
            {saving ? 'Saving…' : 'Save home base'}
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary flex-1 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={saving}
            onClick={handleDone}
          >
            {saving ? 'Saving…' : 'Done'}
          </button>
        )}
        <button
          type="button"
          onClick={handleSkip}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-sm font-medium text-[#6B6458] border border-[#E8E4DA] hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          Skip
        </button>
      </div>
    </div>
  )
}
