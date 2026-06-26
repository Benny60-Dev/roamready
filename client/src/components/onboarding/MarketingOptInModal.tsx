import { useState } from 'react'
import { Mail } from 'lucide-react'
import { usersApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'

/**
 * FR-MARKETING-OPTIN — explicit marketing-email opt-in shown once at onboarding.
 *
 * Gating lives in the parent (OnboardingPage): render this ONLY when the user has
 * no recorded decision (marketingConsentAt == null). Either action records a
 * decision and stamps marketingConsentAt server-side, so it never re-fires.
 *
 * CAN-SPAM / explicit-consent rules baked in:
 *  - the checkbox is UNCHECKED by default — consent is never pre-checked or assumed
 *  - "Subscribe" records the checkbox's ACTUAL state (true only if the user ticked
 *    it); "No thanks" records false. Neither path can record consent the user
 *    didn't affirmatively give.
 *  - kept entirely SEPARATE from Terms/Privacy acceptance (a legally distinct act).
 */
export default function MarketingOptInModal({ onDecided }: { onDecided: () => void }) {
  const { user, setUser } = useAuthStore()
  const [checked, setChecked] = useState(false) // explicit opt-in — never pre-checked
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function record(consent: boolean) {
    setSaving(true)
    setError('')
    try {
      const res = await usersApi.updateMarketingConsent(consent)
      // Merge the server's updated flag + timestamp so the gate (marketingConsentAt
      // == null) closes immediately and the modal never re-fires this session.
      if (user) setUser({ ...user, ...res.data })
      onDecided()
    } catch {
      setError("Couldn't save your preference. Please try again.")
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card-lg w-full max-w-sm">
        <div className="flex items-center gap-2 mb-2">
          <div className="flex items-center justify-center w-9 h-9 rounded-full bg-[#E0F0F4]">
            <Mail size={18} className="text-[#1F6F8B]" />
          </div>
          <h2 className="text-lg font-medium text-gray-900">Trip tips in your inbox?</h2>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          Get occasional emails with trip-planning tips, new features, and seasonal RV deals.
          You can change this anytime in your profile.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-100 text-red-700 text-sm rounded-lg px-3 py-2 mb-3">
            {error}
          </div>
        )}

        <label className="flex items-start gap-2 cursor-pointer select-none mb-5">
          <input
            type="checkbox"
            className="mt-0.5 rounded"
            checked={checked}
            onChange={e => setChecked(e.target.checked)}
          />
          <span className="text-sm text-gray-700">
            Yes, send me RoamReady trip tips and offers by email.
          </span>
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => record(false)}
            disabled={saving}
            className="btn-ghost flex-1"
          >
            No thanks
          </button>
          <button
            type="button"
            onClick={() => record(checked)}
            disabled={saving}
            className="btn-primary flex-1"
          >
            {saving ? 'Saving...' : 'Save preference'}
          </button>
        </div>
      </div>
    </div>
  )
}
