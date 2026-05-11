// Magic-link landing page. Hit when a user clicks the verification
// link from their email. Public route (not behind PrivateRoute) — the
// user may be logged out, on a different device, or on a different
// browser than the one that triggered the send.
//
// Flow:
//   - Mount → read ?token=... from query string
//   - Missing token → "Invalid link" state
//   - Call GET /auth/verify-email?token=...
//   - 200 → success state + "Continue to RoamReady" button to /dashboard.
//     If we're currently logged in as the user being verified, also
//     refresh the auth store so emailVerified flips to true and the
//     post-success navigation doesn't bounce them into the gate screen.
//   - 404 → "Link no longer valid" state + sign-in CTA
//
// Visual treatment: same calm centered-card pattern as the gate screen.
// Page bg #F5F4F2, white card with a colored 2px border that signals
// state (success = success-teal, loading = RV Blue, failure = warning
// amber). All within the locked palette.
import { useEffect, useRef, useState } from 'react'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { api, usersApi } from '../services/api'
import { useAuthStore } from '../store/authStore'

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'success'; email: string }
  | { kind: 'invalid' }

export default function VerifyEmailPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const setUser = useAuthStore(s => s.setUser)
  const isAuthenticated = useAuthStore(s => s.isAuthenticated())

  const token = params.get('token')
  const [state, setState] = useState<State>(token ? { kind: 'loading' } : { kind: 'missing' })

  // Guard against React 18 StrictMode's intentional double-mount in
  // dev — without this, the verify endpoint gets called twice and the
  // second call sees the token already consumed → 404 → "invalid"
  // state stomps the "success" state. Ref persists across the double
  // invoke; effect early-returns the second time.
  const calledRef = useRef(false)

  useEffect(() => {
    if (!token) return
    if (calledRef.current) return
    calledRef.current = true

    ;(async () => {
      try {
        const res = await api.get('/auth/verify-email', { params: { token } })
        setState({ kind: 'success', email: res.data.email })
        // If we're already logged in as this user, refresh the store so
        // emailVerified flips. The "Continue to RoamReady" button below
        // navigates to /dashboard; without the refresh, PrivateRoute
        // could bounce them straight into the gate screen.
        if (isAuthenticated) {
          try {
            const me = await usersApi.getMe()
            setUser(me.data)
          } catch {
            // Non-fatal — they're verified server-side; the next page
            // load will re-rehydrate. Don't block the success screen.
          }
        }
      } catch (err: any) {
        // 404 → already used / never existed. Anything else (network
        // blip, 500) lands in the same "invalid" bucket because there's
        // not much else useful to say to the user. They can request a
        // fresh link from settings.
        setState({ kind: 'invalid' })
      }
    })()
  }, [token, isAuthenticated, setUser])

  // Each state picks its accent color from the locked palette. Border
  // color is the only visual differentiation on the card.
  const accent =
    state.kind === 'success' ? '#1D9E75' :       // success teal
    state.kind === 'invalid' || state.kind === 'missing' ? '#C9851A' : // amber (darker gold)
    '#1F6F8B'                                     // RV Blue (loading)

  return (
    <div
      className="flex flex-col items-center justify-center px-4 py-12"
      style={{ minHeight: '100dvh', backgroundColor: '#F5F4F2' }}
    >
      <div className="mb-8 text-2xl">
        <span style={{ color: '#1F6F8B' }}>Roam</span>
        <span style={{ color: '#F7A829' }}>ready</span>
        <span style={{ color: '#1F6F8B' }}>.ai</span>
      </div>

      <div
        className="w-full max-w-[480px] rounded-xl bg-white p-8"
        style={{ border: `2px solid ${accent}` }}
      >
        {state.kind === 'loading' && (
          <div className="flex flex-col items-center text-center">
            <Loader2 size={32} className="animate-spin mb-4" style={{ color: accent }} aria-hidden="true" />
            <h1 className="text-lg font-medium text-gray-900 mb-2">Verifying your email…</h1>
            <p className="text-sm text-gray-700">Hang tight — this should only take a moment.</p>
          </div>
        )}

        {state.kind === 'success' && (
          <div className="flex flex-col items-center text-center">
            <CheckCircle2 size={32} className="mb-4" style={{ color: accent }} aria-hidden="true" />
            <h1 className="text-lg font-medium text-gray-900 mb-2">Email verified!</h1>
            <p className="text-sm text-gray-700 mb-6">
              {state.email} is confirmed. Welcome aboard.
            </p>
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="w-full py-2.5 rounded-lg text-sm font-medium transition-colors bg-[#F7A829] text-white hover:bg-[#C9851A]"
            >
              Continue to RoamReady
            </button>
          </div>
        )}

        {state.kind === 'invalid' && (
          <div className="flex flex-col items-center text-center">
            <AlertTriangle size={32} className="mb-4" style={{ color: accent }} aria-hidden="true" />
            <h1 className="text-lg font-medium text-gray-900 mb-2">Link no longer valid</h1>
            <p className="text-sm text-gray-700 mb-6">
              This verification link is no longer valid. It may have already been used.
            </p>
            <Link
              to="/login"
              className="w-full block text-center py-2.5 rounded-lg text-sm font-medium transition-colors bg-[#F7A829] text-white hover:bg-[#C9851A]"
            >
              Sign in to request a new link
            </Link>
          </div>
        )}

        {state.kind === 'missing' && (
          <div className="flex flex-col items-center text-center">
            <AlertTriangle size={32} className="mb-4" style={{ color: accent }} aria-hidden="true" />
            <h1 className="text-lg font-medium text-gray-900 mb-2">Invalid link</h1>
            <p className="text-sm text-gray-700 mb-6">
              This link is missing a verification token. Check the link you clicked, or sign in to request a new one.
            </p>
            <Link
              to="/login"
              className="w-full block text-center py-2.5 rounded-lg text-sm font-medium transition-colors bg-[#F7A829] text-white hover:bg-[#C9851A]"
            >
              Sign in
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
