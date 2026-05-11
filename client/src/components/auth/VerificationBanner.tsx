// In-grace verification banner — full-width strip at the top of the
// authed app, sits just below the AppLayout's sunset gradient strip.
// Only renders when isInGracePeriod === true (caller gates this; the
// component itself trusts that condition).
//
// Countdown updates every 30s, not every second — the user doesn't
// need second-level precision and a 30s tick avoids the cost of 119
// extra renders per minute across every authed page. When < 5 minutes
// remain, the wording switches to a softer urgency-bump.
//
// Non-dismissable by design: a dismissable banner would let a user
// hide the only thing telling them their session is about to lock.
// The fix is to verify, not to hide.
import { useEffect, useState } from 'react'
import { Mail } from 'lucide-react'
import { useAuthStore, computeGracePeriodMsRemaining } from '../../store/authStore'
import { api } from '../../services/api'

const COUNTDOWN_TICK_MS = 30 * 1000
const URGENCY_THRESHOLD_MS = 5 * 60 * 1000

/** Format ms remaining as "Xm Ys" (>= 1 minute) or "Xm" (< 5 minutes —
 *  the urgency-bump wording reads "X minutes" anyway so we strip
 *  seconds). Seconds-only never displayed: at < 1 minute we just say
 *  "less than a minute". */
function formatRemaining(msRemaining: number, urgent: boolean): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (urgent) {
    return minutes === 0 ? 'less than a minute' : `${minutes} minute${minutes !== 1 ? 's' : ''}`
  }
  return `${minutes}m ${seconds}s`
}

export function VerificationBanner() {
  const user = useAuthStore(s => s.user)
  // Trigger re-render every 30s so the countdown ticks. Stored value
  // is just a counter — what matters is the side effect, not the value.
  const [, setTick] = useState(0)
  // Resend cooldown state — server returns 429 TOO_SOON with retryAfter
  // (in seconds). We mirror that on the button so the user sees the
  // wait rather than a generic "try again later" toast.
  const [cooldownSeconds, setCooldownSeconds] = useState(0)
  const [sending, setSending] = useState(false)
  const [justSent, setJustSent] = useState(false)

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), COUNTDOWN_TICK_MS)
    return () => clearInterval(interval)
  }, [])

  // Independent 1-second tick for the cooldown countdown — only runs
  // while cooldown is active so it costs nothing when the button is idle.
  useEffect(() => {
    if (cooldownSeconds <= 0) return
    const t = setTimeout(() => setCooldownSeconds(s => Math.max(0, s - 1)), 1000)
    return () => clearTimeout(t)
  }, [cooldownSeconds])

  const msRemaining = computeGracePeriodMsRemaining(user)
  const urgent = msRemaining < URGENCY_THRESHOLD_MS
  const message = urgent
    ? `Verify your email within ${formatRemaining(msRemaining, true)} — your access expires soon.`
    : `Verify your email within ${formatRemaining(msRemaining, false)} to keep using RoamReady.`

  async function handleResend() {
    if (sending || cooldownSeconds > 0) return
    setSending(true)
    setJustSent(false)
    try {
      await api.post('/auth/resend-verification')
      setJustSent(true)
    } catch (err: any) {
      // 429 TOO_SOON — surface server's retryAfter (in seconds) on the
      // button. Any other error: fail silently for now (banner stays;
      // user can retry).
      if (err?.response?.status === 429) {
        const retryAfter = err.response.data?.retryAfter
        if (typeof retryAfter === 'number' && retryAfter > 0) {
          setCooldownSeconds(retryAfter)
        }
      }
    } finally {
      setSending(false)
    }
  }

  const buttonDisabled = sending || cooldownSeconds > 0
  const buttonLabel = sending
    ? 'Sending…'
    : cooldownSeconds > 0
      ? `Wait ${cooldownSeconds}s`
      : justSent
        ? 'Sent ✓'
        : 'Resend email'

  return (
    <div
      // Pale RV Blue background, full width. Brand-on-brand calm — not
      // amber-warning, not red-alarm. Sits below the sunset gradient
      // strip; the bottom-border separates it from the page content.
      className="w-full flex items-center justify-center gap-3 px-4 py-2 text-sm"
      style={{
        backgroundColor: '#E0F0F4',
        color: '#134756',
        borderBottom: '1px solid #C7DCE3',
      }}
    >
      <Mail size={14} aria-hidden="true" className="flex-shrink-0" />
      <span className="flex-1 text-center sm:text-left">{message}</span>
      <button
        type="button"
        onClick={handleResend}
        disabled={buttonDisabled}
        className="flex-shrink-0 text-xs font-medium underline underline-offset-2 disabled:opacity-60 disabled:cursor-not-allowed disabled:no-underline"
        style={{ color: '#134756' }}
      >
        {buttonLabel}
      </button>
    </div>
  )
}
