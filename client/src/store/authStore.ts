import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { User } from '../types'

// 1-hour app-side grace window from createdAt before an unverified
// user is hard-gated. Mirrors GRACE_PERIOD_MS in
// server/src/middleware/requireVerifiedEmail.ts — keep these in sync.
const GRACE_PERIOD_MS = 60 * 60 * 1000

/** Milliseconds remaining until the 1-hour verification grace expires.
 *  Returns 0 if the user is already verified, is an owner, has no
 *  createdAt set, or is already past grace. Exported as a standalone
 *  pure function so the banner's setInterval-driven countdown can
 *  call it on every tick without going through the store. */
export function computeGracePeriodMsRemaining(user: User | null): number {
  if (!user) return 0
  if (user.isOwner) return 0
  if (user.emailVerified) return 0
  if (!user.createdAt) return 0
  const graceEndsAt = new Date(user.createdAt).getTime() + GRACE_PERIOD_MS
  return Math.max(0, graceEndsAt - Date.now())
}

interface AuthState {
  user: User | null
  token: string | null
  isLoading: boolean
  setUser: (user: User | null) => void
  setToken: (token: string | null) => void
  setLoading: (loading: boolean) => void
  logout: () => void
  isAuthenticated: () => boolean
  hasAccess: (feature: string) => boolean
  rehydrateUser: () => Promise<void>
  // Email-verification derived state — read at render time. Owner
  // accounts always resolve as verified (isVerified: true; the other
  // two: false) so owners never see the banner or gate.
  isVerified: () => boolean
  isInGracePeriod: () => boolean
  isPastGracePeriod: () => boolean
}

const FEATURE_GATES: Record<string, string[]> = {
  campgroundBooking: ['PRO'],
  rigCompatibilityFilter: ['PRO'],
  militaryCampgrounds: ['PRO'],
  ohvDestinations: ['PRO'],
  vanDestinations: ['PRO'],
  pdfExport: ['PRO'],
  tripSharing: ['PRO'],
  resourcesAlongRoute: ['PRO'],
  packingListGenerator: ['PRO'],
  tripJournal: ['PRO'],
  maintenanceTracker: ['PRO'],
  weatherAlerts: ['PRO'],
  aiPlannerUnlimited: ['PRO'],
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isLoading: false,
      setUser: (user) => set({ user }),
      setToken: (token) => set({ token }),
      setLoading: (isLoading) => set({ isLoading }),
      logout: () => set({ user: null, token: null }),
      isAuthenticated: () => !!get().token,
      rehydrateUser: async () => {
        if (!get().token) return
        try {
          // Inline import to avoid a circular dependency between the store and the api module
          const { usersApi } = await import('../services/api')
          const res = await usersApi.getMe()
          set({ user: res.data })
        } catch {
          // Silently ignore — stale store data is better than crashing
        }
      },
      hasAccess: (feature) => {
        // MIRRORS server/src/middleware/auth.ts hasAccess — keep the clause set
        // and ORDER in sync (owner → trial → paid-through grace → comp → tier
        // gate). A comp-blind client check here paywalled comped users whose
        // server access already passed (subscriptionTier=FREE + compTier=PRO).
        const user = get().user
        if (!user) return false
        if (user.isOwner) return true
        if (user.trialEndsAt && new Date() < new Date(user.trialEndsAt)) return true
        // Cancellation grace: paid through subscriptionEndsAt even if tier flipped
        // to FREE by the cancellation webhook.
        if (user.subscriptionEndsAt && new Date() < new Date(user.subscriptionEndsAt)) return true
        // Complimentary (owner-granted) Pro — independent of Stripe. Valid when
        // compTier is PRO and either lifetime (no expiry) or not yet expired.
        if (user.compTier === 'PRO' && (!user.compExpiresAt || new Date() < new Date(user.compExpiresAt))) return true
        const gates = FEATURE_GATES[feature]
        if (!gates) return true
        return gates.includes(user.subscriptionTier)
      },
      // Email-verification derived state. Owner bypass mirrors the
      // server-side requireVerifiedEmail middleware: isOwner === true
      // resolves as verified, never as in/past grace.
      isVerified: () => {
        const user = get().user
        if (!user) return false
        if (user.isOwner) return true
        return user.emailVerified === true
      },
      isInGracePeriod: () => {
        const user = get().user
        if (!user) return false
        if (user.isOwner) return false
        if (user.emailVerified) return false
        if (!user.createdAt) return false
        const graceEndsAt = new Date(user.createdAt).getTime() + GRACE_PERIOD_MS
        return graceEndsAt > Date.now()
      },
      isPastGracePeriod: () => {
        const user = get().user
        if (!user) return false
        if (user.isOwner) return false
        if (user.emailVerified) return false
        if (!user.createdAt) return false
        const graceEndsAt = new Date(user.createdAt).getTime() + GRACE_PERIOD_MS
        return graceEndsAt <= Date.now()
      },
    }),
    {
      name: 'roamready-auth',
      partialize: (state) => ({ token: state.token, user: state.user }),
    }
  )
)
