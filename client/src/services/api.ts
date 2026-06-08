import axios from 'axios'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'

export const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
})

api.interceptors.request.use(config => {
  const token = useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  res => res,
  async error => {
    const original = error.config

    // 401 → try silent token refresh, then retry once
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true
      try {
        const res = await axios.post('/api/v1/auth/refresh', {}, { withCredentials: true })
        const newToken = res.data.accessToken
        useAuthStore.getState().setToken(newToken)
        original.headers.Authorization = `Bearer ${newToken}`
        return api(original)
      } catch {
        useAuthStore.getState().logout()
        window.location.href = '/login'
      }
    }

    // 429 → wait and retry once. The server's rate-limit middleware emits
    // RateLimit-* headers (standardHeaders: true) including Retry-After when
    // the budget is exhausted; we honor it but cap at 5s so a misconfigured
    // huge value doesn't freeze the UI. Default to 2s when no header is sent.
    // The _retried429 flag is separate from _retry so a 401→refresh→retry that
    // happens to also 429 still gets one rate-limit recovery shot.
    if (error.response?.status === 429 && original && !original._retried429) {
      const retryAfterRaw = error.response.headers?.['retry-after'] ?? '2'
      const retryAfterSec = parseInt(retryAfterRaw, 10)
      const safeSec = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 2
      const delayMs = Math.min(safeSec * 1000, 5000)
      original._retried429 = true
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return api(original)
    }

    // 403 FEATURE_GATED → open the paywall modal centrally. The server's
    // requireFeature(...) middleware throws AppError(... 403, { code:
    // 'FEATURE_GATED', feature }) — that envelope is the contract this
    // branch reads. Every gated route (AI, PDF export, trip sharing, etc.)
    // funnels through here so we don't need each call site to detect 403s
    // and open the modal individually; per-site catches just suppress
    // their generic "Sorry, I had trouble responding" messages on this
    // code so the paywall isn't double-narrated.
    //
    // No redirectOnDismiss — these errors fire from pages the user can
    // still meaningfully view (their trip, the canvas, the modify panel).
    // The paywall-dismiss fix's close-in-place behavior is the right
    // default; the proactive Pro-only pages (Ohv/Van/TripBooking) keep
    // their own openPaywall calls with redirectOnDismiss because their
    // shells are empty without Pro — different cohort.
    //
    // Promise still rejects after the modal opens so callers' catch
    // blocks still run for loading-state cleanup. The double-narration
    // suppression is each catch's job, not the interceptor's.
    if (
      error.response?.status === 403 &&
      error.response?.data?.code === 'FEATURE_GATED' &&
      typeof error.response.data.feature === 'string'
    ) {
      useUIStore.getState().openPaywall(error.response.data.feature)
    }

    return Promise.reject(error)
  }
)

// Auth
export const authApi = {
  register: (data: any) => api.post('/auth/register', data),
  login: (email: string, password: string) => api.post('/auth/login', { email, password }),
  logout: () => api.post('/auth/logout'),
  getMe: () => api.get('/auth/me'),
  forgotPassword: (email: string) => api.post('/auth/forgot-password', { email }),
  resetPassword: (token: string, password: string) => api.post('/auth/reset-password', { token, password }),
}

// Users
export const usersApi = {
  getMe: () => api.get('/users/me'),
  updateMe: (data: any) => api.put('/users/me', data),
  deleteMe: () => api.delete('/users/me'),
  getRigs: () => api.get('/users/me/rigs'),
  createRig: (data: any) => api.post('/users/me/rigs', data),
  updateRig: (id: string, data: any) => api.put(`/users/me/rigs/${id}`, data),
  deleteRig: (id: string) => api.delete(`/users/me/rigs/${id}`),
  getTravelProfile: () => api.get('/users/me/travel-profile'),
  updateTravelProfile: (data: any) => api.put('/users/me/travel-profile', data),
  getMemberships: () => api.get('/users/me/memberships'),
  createMembership: (data: any) => api.post('/users/me/memberships', data),
  updateMembership: (id: string, data: any) => api.put(`/users/me/memberships/${id}`, data),
  deleteMembership: (id: string) => api.delete(`/users/me/memberships/${id}`),
  // Travel Party (Phase B)
  getParties: () => api.get('/users/me/parties'),
  getDefaultParty: () => api.get('/users/me/parties/default'),
  createParty: (data: any) => api.post('/users/me/parties', data),
  updateParty: (partyId: string, data: any) => api.put(`/users/me/parties/${partyId}`, data),
  deleteParty: (partyId: string) => api.delete(`/users/me/parties/${partyId}`),
  createPerson: (partyId: string, data: any) => api.post(`/users/me/parties/${partyId}/people`, data),
  updatePerson: (partyId: string, id: string, data: any) => api.put(`/users/me/parties/${partyId}/people/${id}`, data),
  deletePerson: (partyId: string, id: string) => api.delete(`/users/me/parties/${partyId}/people/${id}`),
  createPet: (partyId: string, data: any) => api.post(`/users/me/parties/${partyId}/pets`, data),
  updatePet: (partyId: string, id: string, data: any) => api.put(`/users/me/parties/${partyId}/pets/${id}`, data),
  deletePet: (partyId: string, id: string) => api.delete(`/users/me/parties/${partyId}/pets/${id}`),
}

// Trips
export const tripsApi = {
  getAll: () => api.get('/trips'),
  create: (data: any) => api.post('/trips', data),
  get: (id: string) => api.get(`/trips/${id}`),
  update: (id: string, data: any) => api.put(`/trips/${id}`, data),
  shiftDates: (id: string, body: { newStartDate: string }) => api.post(`/trips/${id}/shift-dates`, body),
  delete: (id: string) => api.delete(`/trips/${id}`),
  getShared: (token: string) => api.get(`/trips/share/${token}`),
  createShare: (id: string) => api.post<{ sharedToken: string; regenerated: boolean }>(`/trips/${id}/share`),
  regenerateShare: (id: string) => api.post<{ sharedToken: string; regenerated: boolean }>(`/trips/${id}/share/regenerate`),
  revokeShare: (id: string) => api.delete<{ sharedToken: null; revoked: boolean }>(`/trips/${id}/share`),
  getStops: (id: string) => api.get(`/trips/${id}/stops`),
  createStop: (id: string, data: any) => api.post(`/trips/${id}/stops`, data),
  updateStop: (id: string, stopId: string, data: any) => api.put(`/trips/${id}/stops/${stopId}`, data),
  deleteStop: (id: string, stopId: string) => api.delete(`/trips/${id}/stops/${stopId}`),
  generatePackingList: (id: string) => api.post(`/trips/${id}/packing-list`),
  exportPdf: (id: string) => api.post(`/trips/${id}/export/pdf`),
  reassignPOIs: (id: string) => api.post(`/trips/${id}/stops/reassign-pois`),
  expandLongLegs: (id: string) => api.post(`/trips/${id}/expand-long-legs`),
  generateItinerary: (id: string) => api.post(`/trips/${id}/itinerary/generate`),
  saveItinerary: (id: string, itinerary: any[]) => api.put(`/trips/${id}/itinerary`, itinerary),
  generateRoutes: (id: string) => api.post(`/trips/${id}/routes`),
  generateActivities: (id: string) => api.post(`/trips/${id}/activities/generate`),
  generateRouteHighlights: (id: string, stopId: string) => api.post(`/trips/${id}/stops/${stopId}/highlights`),
  getMapImage: (id: string) => api.get(`/trips/${id}/map-image`),
  getWeather:  (id: string) => api.get(`/trips/${id}/weather`),
  // Per-leg fuel-cost estimate priced via the EIA regional retail feed (pass 2
  // of the fuel-budget feature). Returns total + perLeg + freshness metadata;
  // see TripFuelEstimate in types/index.ts.
  getFuelEstimate: (id: string) => api.get<import('../types').TripFuelEstimate>(`/trips/${id}/fuel-estimate`),
}

// Planning Sessions
import type { PlanningSession } from '../types'

export interface PromoteSessionPayload {
  rigId?: string | null
  name: string
  startLocation: string
  endLocation: string
  startDate?: Date | string | null
  endDate?: Date | string | null
  totalMiles?: number | null
  totalNights?: number | null
  estimatedFuel?: number | null
  estimatedCamp?: number | null
  fuelPrice?: number | null
  // Block 8 — per-trip vehicle decisions from the ConfirmVehiclesModal.
  // See server/src/schemas/planningSession.ts PlanningSessionPromoteSchema
  // and prisma/schema.prisma Trip model for the full semantics.
  bringingTowed?: boolean | null
  adHocVehicle?: { year?: number; make?: string; model?: string; length?: number } | null
}

export interface UpdateSessionPayload {
  title?: string | null
  messages?: any[]
  partialTripData?: any
  status?: 'PLANNING' | 'COMPLETED' | 'ARCHIVED'
}

export const sessionsApi = {
  list: () => api.get<PlanningSession[]>('/sessions'),
  getLatestActive: async (): Promise<PlanningSession | null> => {
    try {
      const res = await api.get<PlanningSession>('/sessions/latest-active')
      return res.data
    } catch (e: any) {
      if (e?.response?.status === 404) return null
      throw e
    }
  },
  get: (id: string) => api.get<PlanningSession>(`/sessions/${id}`),
  create: (data: { title?: string | null } = {}) =>
    api.post<PlanningSession>('/sessions', data),
  update: (id: string, data: UpdateSessionPayload) =>
    api.put<PlanningSession>(`/sessions/${id}`, data),
  promote: (id: string, data: PromoteSessionPayload) =>
    api.post<{ session: PlanningSession; trip: any }>(`/sessions/${id}/promote`, data),
  delete: (id: string) => api.delete<PlanningSession>(`/sessions/${id}`),
}

// AI
export const aiApi = {
  chat: (
    messages: any[],
    tripId?: string,
    context?: string,
    sessionId?: string,
    rig?: { rigId?: string | null; adHocVehicle?: { year?: number; make?: string; model?: string; length?: number } },
  ) => api.post('/ai/chat', { messages, tripId, context, sessionId, ...(rig ?? {}) }),
  getChatHistory: (tripId: string) => api.get(`/ai/chat/${tripId}/history`),
  getModifyHistory: (tripId: string) => api.get(`/ai/chat/${tripId}/modify-history`),
  generatePackingList: (tripId: string) => api.post('/ai/generate-packing-list', { tripId }),
  analyzeFeedback: () => api.post('/ai/analyze-feedback'),
}

// Campgrounds
export const campgroundsApi = {
  search: (params: any) => api.get('/campgrounds/search', { params }),
  get: (id: string) => api.get(`/campgrounds/${id}`),
  getCompatible: (params: any) => api.get('/campgrounds/compatible', { params }),
  getMilitary: () => api.get('/campgrounds/military'),
  getOhv: (lat?: number, lng?: number, radius?: number) =>
    api.get('/campgrounds/ohv', { params: { lat, lng, radius } }),
  getVan: () => api.get('/campgrounds/van'),
  getCarCamping: () => api.get('/campgrounds/car-camping'),
}

// Resources
export const resourcesApi = {
  get: (lat: number, lng: number, type: string, radius?: number) =>
    api.get('/resources', { params: { lat, lng, type, radius } }),
}

// Maintenance
export const maintenanceApi = {
  getItems: (rigId: string) => api.get(`/maintenance/${rigId}`),
  createItem: (rigId: string, data: any) => api.post(`/maintenance/${rigId}`, data),
  updateItem: (rigId: string, itemId: string, data: any) => api.put(`/maintenance/${rigId}/${itemId}`, data),
  logService: (rigId: string, itemId: string, data: any) => api.post(`/maintenance/${rigId}/${itemId}/log`, data),
  getHistory: (rigId: string) => api.get(`/maintenance/${rigId}/history`),
}

// Journal
export const journalApi = {
  // Freeform diary CRUD (step 3 endpoints). list() accepts optional query
  // filters: { tripId, state, tag, rating, q }.
  list: (params?: Record<string, string | number | undefined>) => api.get('/journal', { params }),
  get: (id: string) => api.get(`/journal/${id}`),
  create: (data: any) => api.post('/journal', data),
  update: (id: string, data: any) => api.put(`/journal/${id}`, data),
  delete: (id: string) => api.delete(`/journal/${id}`),
  // Legacy per-stop journal (still live — TripJournalPage uses these).
  upsert: (stopId: string, data: any) => api.post(`/journal/${stopId}`, data),
  uploadPhotos: (stopId: string, formData: FormData) =>
    api.post(`/journal/${stopId}/photos`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
}

// Visited states — manual marks for the Journal map (step 6b). Reads open;
// writes Pro-gated server-side (requireFeature('tripJournal')).
export const visitedStatesApi = {
  list: () => api.get('/visited-states'),
  upsert: (state: string, visitType: 'overnight' | 'passthrough') =>
    api.put(`/visited-states/${state}`, { visitType }),
  remove: (state: string) => api.delete(`/visited-states/${state}`),
}

// Feedback
export const feedbackApi = {
  submit: (data: any) => api.post('/feedback', data),
  getPublic: () => api.get('/feedback/public'),
  vote: (id: string) => api.post(`/feedback/${id}/vote`),
  getAdmin: () => api.get('/feedback/admin'),
  updateStatus: (id: string, status: string) => api.put(`/feedback/${id}/status`, { status }),
}

// Subscriptions
export const subscriptionsApi = {
  createCheckout: (priceId: string) => api.post('/subscriptions/checkout', { priceId }),
  createPortal: () => api.post('/subscriptions/portal'),
  getStatus: () => api.get('/subscriptions/status'),
  getInvoices: () => api.get('/subscriptions/invoices'),
}

// Notifications
export const notificationsApi = {
  getAll: () => api.get('/notifications'),
  updateSettings: (settings: any) => api.put('/notifications/settings', settings),
  markRead: (id: string) => api.post(`/notifications/${id}/read`),
  delete: (id: string) => api.delete(`/notifications/${id}`),
}

// Admin
export const adminApi = {
  getMetrics: () => api.get('/admin/metrics'),
  getSubscribers: () => api.get('/admin/subscribers'),
  getRevenue: () => api.get('/admin/revenue'),
  getFeedback: () => api.get('/admin/feedback'),
  analyzeFeedback: () => api.post('/admin/feedback/analyze'),
  getLinkHealth: () => api.get('/admin/link-health'),
}
