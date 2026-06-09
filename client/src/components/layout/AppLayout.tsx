import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Home, LayoutDashboard, Compass, User, Menu, X, LogOut, ChevronDown, Clock, HelpCircle } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '../../store/authStore'
import { authApi } from '../../services/api'
import SessionsPanel from '../sessions/SessionsPanel'
import { VerificationBanner } from '../auth/VerificationBanner'

export default function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false)
  const { user, logout } = useAuthStore()
  const isInGracePeriod = useAuthStore(s => s.isInGracePeriod())
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const profileRef = useRef<HTMLDivElement>(null)

  async function handleLogout() {
    await authApi.logout()
    logout()
    navigate('/login')
  }

  // Close the profile dropdown on any click/tap outside it (trigger + menu are
  // both inside profileRef, so tapping the avatar still toggles via its onClick
  // without this closing it first). Gated on profileOpen so the listener only
  // exists while open; removed on close/unmount (no leak). Mirrors the app's
  // existing click-away pattern (components/OhvResourceBlock.tsx).
  useEffect(() => {
    if (!profileOpen) return
    const onDown = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [profileOpen])

  // Also dismiss on navigation (e.g. tapping a bottom-nav item) so the menu
  // never lingers across route changes.
  useEffect(() => {
    setProfileOpen(false)
  }, [pathname])

  // Home now IS the AI planning canvas. Its `to` is /sessions/new, which
  // SessionNewPage immediately redirects to /sessions/:id (resume the latest
  // active session, or create a fresh one). NavLink's default isActive (exact
  // or `to + '/'` prefix) wouldn't match once we land on /sessions/<uuid>,
  // so matchPrefix '/sessions' is what keeps Home highlighted on the canvas.
  // No other nav item routes under /sessions, so this can't double-highlight.
  //
  // Retired (Block 2a): the separate "Plan" item (folded into Home), "Trips"
  // (folds into Dashboard in Block 3), and "Bookings" (returns in Block 5).
  // The /trips, /reservations, /sessions/new, /trips/new routes remain alive
  // for deep links and back-compat — only their nav slots were removed.
  const navLinks: Array<{ to: string; icon: typeof Home; label: string; matchPrefix?: string }> = [
    { to: '/sessions/new', icon: Home,            label: 'Home', matchPrefix: '/sessions' },
    { to: '/dashboard',    icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/resources',    icon: Compass,         label: 'Resources' },
    { to: '/profile',      icon: User,            label: 'Profile' },
  ]

  // Desktop-only — keeps the 5-item mobile bottom tab bar from getting crowded.
  // Mobile users still reach Help via the slide-out sidebar (which renders this list).
  const desktopExtraLinks: typeof navLinks = [
    { to: '/help', icon: HelpCircle, label: 'Help' },
  ]

  return (
    // pt-[3.75rem] md:pt-0 reserves the FIXED mobile header's height (h-14 56px
    // + 0.5px border + h-1 gradient 4px ≈ 60px) at the top of the shell, so the
    // VerificationBanner AND <main> both clear it. Offset lives on the shell
    // (not <main>) so the grace-period banner — which sits between header and
    // <main> — stays visible. Desktop header is md:sticky (in-flow), so no
    // offset there (md:pt-0). Mirrors how the fixed bottom nav is reserved by
    // <main>'s pb-32.
    <div className="min-h-[100dvh] bg-rr-bg flex flex-col overflow-x-clip pt-[3.75rem] md:pt-0">
      {/* Top Nav — FIXED on mobile (frozen, never scrolls / can't be clipped),
          md:sticky on desktop (unchanged behavior). z-40: above scrolling
          content, below modals (z-50) / BottomSheet (z-80/81) / dropdown (z-50). */}
      <header className="bg-white border-b border-gray-200 fixed top-0 left-0 right-0 z-40 md:sticky md:top-0" style={{ borderBottomWidth: '0.5px' }}>
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              className="md:hidden p-1.5 rounded-lg hover:bg-gray-100"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            <NavLink to="/sessions/new" className="flex items-center gap-2">
              <img src="/roamready-icon.png" alt="RoamReady" className="h-8 w-auto object-contain" />
              <span className="font-medium hidden sm:block">
                <span style={{ color: '#1F6F8B' }}>Roam</span><span style={{ color: '#F7A829' }}>Ready</span><span style={{ color: '#1F6F8B' }}>.ai</span>
              </span>
            </NavLink>
          </div>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map(({ to, label, matchPrefix }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => {
                  const active = isActive || (matchPrefix ? pathname.startsWith(matchPrefix) : false)
                  return `px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    active ? 'bg-[#E0F0F4] text-[#1F6F8B] font-medium' : 'text-gray-600 hover:bg-gray-100'
                  }`
                }}
              >
                {label}
              </NavLink>
            ))}
            {desktopExtraLinks.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive ? 'bg-[#E0F0F4] text-[#1F6F8B] font-medium' : 'text-gray-600 hover:bg-gray-100'
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
            {user?.isOwner && (
              <NavLink to="/admin" className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-sm transition-colors ${isActive ? 'bg-[#E0F0F4] text-[#1F6F8B] font-medium' : 'text-gray-600 hover:bg-gray-100'}`
              }>Admin</NavLink>
            )}
          </nav>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSessionsPanelOpen(o => !o)}
              aria-label="Planning sessions"
              aria-pressed={sessionsPanelOpen}
              className="flex items-center justify-center transition-colors"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: '0.5px solid',
                borderColor: sessionsPanelOpen ? '#185FA5' : '#E8E4DA',
                backgroundColor: sessionsPanelOpen ? '#E6F1FB' : '#FFFFFF',
                color: sessionsPanelOpen ? '#0C447C' : '#6B6458',
              }}
              onMouseEnter={e => {
                if (!sessionsPanelOpen) e.currentTarget.style.backgroundColor = '#F5F4F2'
              }}
              onMouseLeave={e => {
                if (!sessionsPanelOpen) e.currentTarget.style.backgroundColor = '#FFFFFF'
              }}
            >
              <Clock size={16} strokeWidth={2} />
            </button>
            {/* Bell button removed May 19 — see Notification audit. Schema + read API exist
                but no code creates Notification rows, so the bell would have nothing to show.
                Restore (alongside a producer + dropdown panel) when the in-app notification
                feed is wired up. */}
            <div className="relative" ref={profileRef}>
              <button
                onClick={() => setProfileOpen(!profileOpen)}
                className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg hover:bg-gray-100"
              >
                <div className="w-7 h-7 bg-[#1F6F8B] rounded-full flex items-center justify-center">
                  <span className="text-white text-xs font-medium">
                    {user?.firstName?.[0]}{user?.lastName?.[0]}
                  </span>
                </div>
                <span className="text-sm text-gray-700 hidden sm:block">{user?.firstName}</span>
                <ChevronDown size={14} className="text-gray-400" />
              </button>
              {profileOpen && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-white rounded-xl border border-gray-200 shadow-sm py-1 z-50"
                  style={{ borderWidth: '0.5px' }}
                >
                  <NavLink to="/profile" className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50" onClick={() => setProfileOpen(false)}>
                    <User size={15} /> Profile
                  </NavLink>
                  <NavLink to="/profile/billing" className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50" onClick={() => setProfileOpen(false)}>
                    Billing
                  </NavLink>
                  <hr className="my-1" style={{ borderWidth: '0.5px' }} />
                  <button onClick={handleLogout} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    <LogOut size={15} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="h-1 w-full" style={{ background: 'var(--rr-sunset-gradient)' }} />
      </header>

      {/* Verification banner — slots in just below the header / gradient
          strip, above all page content. Only renders for unverified
          users inside the 1-hour grace window; verified users + owners
          + past-grace users never see it (past-grace gets the gate
          screen from PrivateRoute instead, never reaches this point). */}
      {isInGracePeriod && <VerificationBanner />}

      {/* Mobile sidebar */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-30 bg-black/30" onClick={() => setSidebarOpen(false)}>
          <div className="w-64 h-full bg-white border-r border-gray-200 pt-4 px-3" onClick={e => e.stopPropagation()}>
            <nav className="flex flex-col gap-1 mt-2">
              {[...navLinks, ...desktopExtraLinks].map(({ to, icon: Icon, label, matchPrefix }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setSidebarOpen(false)}
                  className={({ isActive }) => {
                    const active = isActive || (matchPrefix ? pathname.startsWith(matchPrefix) : false)
                    return `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                      active ? 'bg-[#E0F0F4] text-[#1F6F8B] font-medium' : 'text-gray-600 hover:bg-gray-100'
                    }`
                  }}
                >
                  <Icon size={18} />
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 pt-6 pb-32 md:pb-6">
        <Outlet />
      </main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-40" style={{ borderTopWidth: '0.5px' }}>
        <div className="flex">
          {navLinks.map(({ to, icon: Icon, label, matchPrefix }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => {
                const active = isActive || (matchPrefix ? pathname.startsWith(matchPrefix) : false)
                return `flex-1 flex flex-col items-center py-2 gap-0.5 text-xs ${
                  active ? 'text-[#1F6F8B]' : 'text-gray-500'
                }`
              }}
            >
              <Icon size={20} />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>

      <SessionsPanel open={sessionsPanelOpen} onClose={() => setSessionsPanelOpen(false)} />
    </div>
  )
}
