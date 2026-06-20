// Hard-gate screen for over-grace unverified users. Full-page takeover —
// replaces the entire authed app shell (no sidebar, no top nav). Only
// renders when isPastGracePeriod === true (PrivateRoute gates this).
//
// Visual pattern mirrors the PricingPage Free card: 2px RV Blue border,
// white card, centered on the page bg. Calm, not alarming.
//
// Mobile note: min-h-[100dvh] (NOT 100vh) avoids the iOS Safari zoom
// bug — documented memory item for any full-viewport mobile screen.
import { useState } from 'react'
import { Mail, CheckCircle2 } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { api, usersApi } from '../../services/api'

export function EmailVerificationGate() {
  const user = useAuthStore(s => s.user)
  const setUser = useAuthStore(s => s.setUser)
  const logout = useAuthStore(s => s.logout)

  const [sending, setSending] = useState(false)
  const [justSent, setJustSent] = useState(false)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)

  async function handleResend() {
    if (sending || cooldownSeconds > 0) return
    setSending(true)
    setJustSent(false)
    try {
      await api.post('/auth/resend-verification')
      setJustSent(true)
    } catch (err: any) {
      if (err?.response?.status === 429) {
        const retryAfter = err.response.data?.retryAfter
        if (typeof retryAfter === 'number' && retryAfter > 0) {
          setCooldownSeconds(retryAfter)
          // Start the countdown — chained timeouts inside an arrow fn
          // recursing on itself; simpler than a useEffect dance for a
          // value that only changes on user action.
          const tick = () => setCooldownSeconds(s => {
            if (s > 1) setTimeout(tick, 1000)
            return Math.max(0, s - 1)
          })
          setTimeout(tick, 1000)
        }
      }
    } finally {
      setSending(false)
    }
  }

  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    setRefreshMessage(null)
    try {
      // Hit /users/me — the FE-exempt endpoint that the auth store
      // already uses for rehydration. Server returns the fresh user
      // record including the current emailVerified flag.
      const res = await usersApi.getMe()
      setUser(res.data)
      if (res.data?.emailVerified) {
        // Gate unmounts on the next render via PrivateRoute reading
        // the freshly-updated isPastGracePeriod() — no further action.
        return
      }
      setRefreshMessage('Not verified yet. Make sure you clicked the link in your email.')
    } catch {
      setRefreshMessage("Couldn't refresh your account state. Try again in a moment.")
    } finally {
      setRefreshing(false)
    }
  }

  const buttonDisabled = sending || cooldownSeconds > 0
  const buttonLabel = sending
    ? 'Sending…'
    : cooldownSeconds > 0
      ? `Wait ${cooldownSeconds}s`
      : justSent
        ? 'Sent ✓'
        : 'Resend verification email'

  return (
    <div
      className="flex flex-col items-center justify-center px-4 py-12"
      style={{ minHeight: '100dvh', backgroundColor: '#F5F4F2' }}
    >
      {/* RoamReady wordmark — small, centered, calm. Same color treatment
          as the public LandingPage hero header. */}
      <div className="mb-8 text-2xl">
        <span style={{ color: '#1F6F8B' }}>Roam</span>
        <span style={{ color: '#F7A829' }}>ready</span>
        <span style={{ color: '#1F6F8B' }}>.ai</span>
      </div>

      <div
        className="w-full max-w-[480px] rounded-xl bg-white p-8"
        style={{ border: '2px solid #1F6F8B' }}
      >
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: '#E0F0F4', color: '#1F6F8B' }}
          >
            <Mail size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-medium text-gray-900">Verify your email to continue</h1>
        </div>

        <p className="text-sm text-gray-700 mb-2">
          We sent a verification link to <span className="font-medium">{user?.email ?? 'your inbox'}</span>.
          The link doesn't expire — click it whenever you're ready.
        </p>

        <p className="text-xs text-gray-500 mb-6">
          Don't see it? Check your spam or junk folder, and mark it "Not Spam" so future emails reach your inbox.
        </p>

        <button
          type="button"
          onClick={handleResend}
          disabled={buttonDisabled}
          className="w-full py-2.5 rounded-lg text-sm font-medium mb-3 transition-colors bg-[#F7A829] text-white hover:bg-[#C9851A] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {buttonLabel}
        </button>

        {/* Resend confirmation — inline, not toast. The confirmation IS
            the value: the user just clicked a button and wants to know
            it worked. */}
        {justSent && (
          <div
            className="flex items-start gap-2 text-xs mb-3 px-3 py-2 rounded-lg"
            style={{ backgroundColor: '#E7F5EE', color: '#0F5F3F' }}
          >
            <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span>Sent — check your inbox and spam folder.</span>
          </div>
        )}

        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="w-full text-center text-sm font-medium underline underline-offset-2 disabled:opacity-50"
          style={{ color: '#1F6F8B' }}
        >
          {refreshing ? 'Checking…' : 'I just verified — refresh'}
        </button>

        {refreshMessage && (
          <p className="text-xs text-gray-600 mt-3 text-center">{refreshMessage}</p>
        )}

        {/* Support footer — separate from the primary CTAs visually
            (margin-top + thin border) so they don't compete. */}
        <div
          className="mt-6 pt-4 flex flex-col items-center gap-2 text-xs text-gray-500"
          style={{ borderTop: '1px solid #E8E4DA' }}
        >
          <span>
            Wrong email?{' '}
            <a href="mailto:support@roamready.ai" className="underline" style={{ color: '#1F6F8B' }}>
              Contact support
            </a>
          </span>
          <button
            type="button"
            onClick={() => logout()}
            className="underline"
            style={{ color: '#1F6F8B' }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
