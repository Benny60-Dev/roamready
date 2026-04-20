import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { User } from '../types'

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
}

const FEATURE_GATES: Record<string, string[]> = {
  campgroundBooking: ['PRO', 'PRO_PLUS'],
  rigCompatibilityFilter: ['PRO', 'PRO_PLUS'],
  militaryCampgrounds: ['PRO', 'PRO_PLUS'],
  ohvDestinations: ['PRO', 'PRO_PLUS'],
  vanDestinations: ['PRO', 'PRO_PLUS'],
  pdfExport: ['PRO', 'PRO_PLUS'],
  tripSharing: ['PRO', 'PRO_PLUS'],
  resourcesAlongRoute: ['PRO', 'PRO_PLUS'],
  packingListGenerator: ['PRO', 'PRO_PLUS'],
  tripJournal: ['PRO', 'PRO_PLUS'],
  maintenanceTracker: ['PRO', 'PRO_PLUS'],
  membershipAutoApply: ['PRO', 'PRO_PLUS'],
  weatherAlerts: ['PRO', 'PRO_PLUS'],
  aiPlannerUnlimited: ['PRO', 'PRO_PLUS'],
  offlineAccess: ['PRO_PLUS'],
  multipleRigProfiles: ['PRO_PLUS'],
  familyAccount: ['PRO_PLUS'],
  prioritySupport: ['PRO_PLUS'],
  rvRecallAlerts: ['PRO_PLUS'],
  costAnalytics: ['PRO_PLUS'],
  unlimitedJournal: ['PRO_PLUS'],
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
        const user = get().user
        if (!user) return false
        if (user.trialEndsAt && new Date() < new Date(user.trialEndsAt)) return true
        const gates = FEATURE_GATES[feature]
        if (!gates) return true
        return gates.includes(user.subscriptionTier)
      },
    }),
    {
      name: 'roamready-auth',
      partialize: (state) => ({ token: state.token, user: state.user }),
    }
  )
)
