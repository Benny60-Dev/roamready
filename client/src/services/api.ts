import axios from 'axios'
import { useAuthStore } from '../store/authStore'

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
}

// Trips
export const tripsApi = {
  getAll: () => api.get('/trips'),
  create: (data: any) => api.post('/trips', data),
  get: (id: string) => api.get(`/trips/${id}`),
  update: (id: string, data: any) => api.put(`/trips/${id}`, data),
  delete: (id: string) => api.delete(`/trips/${id}`),
  getShared: (token: string) => api.get(`/trips/share/${token}`),
  getStops: (id: string) => api.get(`/trips/${id}/stops`),
  createStop: (id: string, data: any) => api.post(`/trips/${id}/stops`, data),
  updateStop: (id: string, stopId: string, data: any) => api.put(`/trips/${id}/stops/${stopId}`, data),
  deleteStop: (id: string, stopId: string) => api.delete(`/trips/${id}/stops/${stopId}`),
  generatePackingList: (id: string) => api.post(`/trips/${id}/packing-list`),
  exportPdf: (id: string) => api.post(`/trips/${id}/export/pdf`),
  generateItinerary: (id: string) => api.post(`/trips/${id}/itinerary/generate`),
  saveItinerary: (id: string, itinerary: any[]) => api.put(`/trips/${id}/itinerary`, itinerary),
  generateRoutes: (id: string) => api.post(`/trips/${id}/routes`),
  generateActivities: (id: string) => api.post(`/trips/${id}/activities/generate`),
  generateRouteHighlights: (id: string, stopId: string) => api.post(`/trips/${id}/stops/${stopId}/highlights`),
  getMapImage: (id: string) => api.get(`/trips/${id}/map-image`),
  getWeather:  (id: string) => api.get(`/trips/${id}/weather`),
}

// AI
export const aiApi = {
  chat: (messages: any[], tripId?: string) => api.post('/ai/chat', { messages, tripId }),
  getChatHistory: (tripId: string) => api.get(`/ai/chat/${tripId}/history`),
  generatePackingList: (tripId: string) => api.post('/ai/generate-packing-list', { tripId }),
  analyzeFeedback: () => api.post('/ai/analyze-feedback'),
}

// Campgrounds
export const campgroundsApi = {
  search: (params: any) => api.get('/campgrounds/search', { params }),
  get: (id: string) => api.get(`/campgrounds/${id}`),
  getCompatible: (params: any) => api.get('/campgrounds/compatible', { params }),
  getMilitary: () => api.get('/campgrounds/military'),
  getOhv: () => api.get('/campgrounds/ohv'),
  getVan: () => api.get('/campgrounds/van'),
  getCarCamping: () => api.get('/campgrounds/car-camping'),
}

// Weather
export const weatherApi = {
  getRoute: (stops: any[], dates: any[]) =>
    api.get('/weather/route', { params: { stops: JSON.stringify(stops), dates: JSON.stringify(dates) } }),
  getStop: (lat: number, lng: number, date?: string) =>
    api.get('/weather/stop', { params: { lat, lng, date } }),
  // Open-Meteo endpoints (free, no API key)
  forecast: (params: { lat: number; lng: number; start_date: string; end_date: string }) =>
    api.get('/weather/forecast', { params }),
  historical: (params: { lat: number; lng: number; month: number; day: number; days: number }) =>
    api.get('/weather/historical', { params }),
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
  getAll: () => api.get('/journal'),
  getTrip: (tripId: string) => api.get(`/journal/${tripId}`),
  upsert: (stopId: string, data: any) => api.post(`/journal/${stopId}`, data),
  uploadPhotos: (stopId: string, formData: FormData) =>
    api.post(`/journal/${stopId}/photos`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
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

// Bookings
export const bookingsApi = {
  getAll: () => api.get('/bookings'),
  create: (data: any) => api.post('/bookings', data),
  get: (id: string) => api.get(`/bookings/${id}`),
  update: (id: string, data: any) => api.put(`/bookings/${id}`, data),
  cancel: (id: string) => api.post(`/bookings/${id}/cancel`),
}

// Admin
export const adminApi = {
  getMetrics: () => api.get('/admin/metrics'),
  getSubscribers: () => api.get('/admin/subscribers'),
  getRevenue: () => api.get('/admin/revenue'),
  getFeedback: () => api.get('/admin/feedback'),
  analyzeFeedback: () => api.post('/admin/feedback/analyze'),
}
