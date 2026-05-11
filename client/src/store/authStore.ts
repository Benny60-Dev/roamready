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
  membershipAutoApply: ['PRO'],
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
        const user = get().user
        if (!user) return false
        if (user.isOwner) return true
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
