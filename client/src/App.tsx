import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { useUIStore } from './store/uiStore'

// Layout
import AppLayout from './components/layout/AppLayout'

// Public pages
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/auth/LoginPage'
import SignupPage from './pages/auth/SignupPage'
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage'
import ResetPasswordPage from './pages/auth/ResetPasswordPage'
import PricingPage from './pages/PricingPage'
import SharedTripPage from './pages/SharedTripPage'
import RoadmapPage from './pages/RoadmapPage'
import AuthCallbackPage from './pages/auth/AuthCallbackPage'
import PrivacyPolicyPage from './pages/PrivacyPolicyPage'
import TermsOfServicePage from './pages/TermsOfServicePage'

// Onboarding
import OnboardingPage from './pages/onboarding/OnboardingPage'

// App pages
import DashboardPage from './pages/DashboardPage'
import TripsPage from './pages/trips/TripsPage'
import NewTripPage from './pages/trips/NewTripPage'
import TripBookingPage from './pages/trips/TripBookingPage'
import TripJournalPage from './pages/trips/TripJournalPage'
import PackingListPage from './pages/PackingListPage'
import ReservationsPage from './pages/ReservationsPage'

// Profile pages
import ProfilePage from './pages/profile/ProfilePage'
import RigPage from './pages/profile/RigPage'
import TravelStylePage from './pages/profile/TravelStylePage'
import MembershipsPage from './pages/profile/MembershipsPage'
import AccessibilityPage from './pages/profile/AccessibilityPage'
import NotificationSettingsPage from './pages/profile/NotificationSettingsPage'
import BillingPage from './pages/profile/BillingPage'

// Tools
import MaintenancePage from './pages/MaintenancePage'
import ResourcesPage from './pages/ResourcesPage'
import OhvDestinationsPage from './pages/OhvDestinationsPage'
import VanDestinationsPage from './pages/VanDestinationsPage'
import CarCampingPage from './pages/CarCampingPage'

// Feedback
import FeedbackPage from './pages/FeedbackPage'

// Admin
import AdminDashboardPage from './pages/admin/AdminDashboardPage'
import AdminFeedbackPage from './pages/admin/AdminFeedbackPage'
import AdminRevenuePage from './pages/admin/AdminRevenuePage'
import AdminSubscribersPage from './pages/admin/AdminSubscribersPage'

// Global modals
import FeedbackModal from './components/feedback/FeedbackModal'
import PaywallModal from './components/feedback/PaywallModal'

// Heavy pages — lazy-loaded so their modules don't block the initial app bundle.
// A runtime error or bad HMR state in these pages cannot crash the login/dashboard.
const TripMapPage     = lazy(() => import('./pages/trips/TripMapPage'))
const TripSummaryPage = lazy(() => import('./pages/trips/TripSummaryPage'))

function TripDetailRedirect() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={`/trips/${id}/map`} replace />
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated())
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />
}

function OwnerRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(s => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (!user.isOwner) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

export default function App() {
  const { feedbackModalOpen, closeFeedbackModal, paywallModal, closePaywall } = useUIStore()
  const rehydrateUser = useAuthStore(s => s.rehydrateUser)

  useEffect(() => {
    rehydrateUser()
  }, [])

  return (
    <BrowserRouter>
      <Suspense fallback={null}>
      <Routes>
        {/* Public */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/roadmap" element={<RoadmapPage />} />
        <Route path="/trips/share/:token" element={<SharedTripPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        <Route path="/terms" element={<TermsOfServicePage />} />

        {/* Onboarding */}
        <Route path="/onboarding/*" element={<PrivateRoute><OnboardingPage /></PrivateRoute>} />

        {/* App */}
        <Route element={<PrivateRoute><AppLayout /></PrivateRoute>}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/trips" element={<TripsPage />} />
          <Route path="/trips/new" element={<NewTripPage />} />
          <Route path="/trips/:id" element={<TripDetailRedirect />} />
          <Route path="/trips/:id/map" element={<TripMapPage />} />
          <Route path="/trips/:id/booking" element={<TripBookingPage />} />
          <Route path="/trips/:id/itinerary" element={<TripSummaryPage />} />
          <Route path="/trips/:id/journal" element={<TripJournalPage />} />
          <Route path="/packing/:tripId" element={<PackingListPage />} />
          <Route path="/reservations" element={<ReservationsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/profile/rig" element={<RigPage />} />
          <Route path="/profile/style" element={<TravelStylePage />} />
          <Route path="/profile/memberships" element={<MembershipsPage />} />
          <Route path="/profile/accessibility" element={<AccessibilityPage />} />
          <Route path="/profile/notifications" element={<NotificationSettingsPage />} />
          <Route path="/profile/billing" element={<BillingPage />} />
          <Route path="/profile/billing/upgrade" element={<PricingPage />} />
          <Route path="/maintenance" element={<MaintenancePage />} />
          <Route path="/resources" element={<ResourcesPage />} />
          <Route path="/ohv-destinations" element={<OhvDestinationsPage />} />
          <Route path="/van-destinations" element={<VanDestinationsPage />} />
          <Route path="/car-camping" element={<CarCampingPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/admin" element={<OwnerRoute><AdminDashboardPage /></OwnerRoute>} />
          <Route path="/admin/feedback" element={<OwnerRoute><AdminFeedbackPage /></OwnerRoute>} />
          <Route path="/admin/revenue" element={<OwnerRoute><AdminRevenuePage /></OwnerRoute>} />
          <Route path="/admin/subscribers" element={<OwnerRoute><AdminSubscribersPage /></OwnerRoute>} />
        </Route>
      </Routes>
      </Suspense>

      {feedbackModalOpen && <FeedbackModal onClose={closeFeedbackModal} />}
      {paywallModal.open && <PaywallModal feature={paywallModal.feature} onClose={closePaywall} />}
    </BrowserRouter>
  )
}
