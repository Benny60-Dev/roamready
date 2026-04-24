import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { Home, Map, MessageSquare, Tent, User, Bell, Menu, X, LogOut, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import logoIcon from '../../assets/logo-icon.png'
import { useAuthStore } from '../../store/authStore'
import { useUIStore } from '../../store/uiStore'
import { authApi } from '../../services/api'
import FeedbackButton from '../feedback/FeedbackButton'

export default function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const { user, logout } = useAuthStore()
  const { openFeedbackModal } = useUIStore()
  const navigate = useNavigate()

  async function handleLogout() {
    await authApi.logout()
    logout()
    navigate('/login')
  }

  const navLinks = [
    { to: '/dashboard', icon: Home, label: 'Home' },
    { to: '/trips', icon: Map, label: 'Trips' },
    { to: '/trips/new', icon: MessageSquare, label: 'Plan' },
    { to: '/reservations', icon: Tent, label: 'Bookings' },
    { to: '/profile', icon: User, label: 'Profile' },
  ]

  return (
    <div className="min-h-screen bg-rr-bg flex flex-col">
      {/* Top Nav */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40" style={{ borderBottomWidth: '0.5px' }}>
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              className="md:hidden p-1.5 rounded-lg hover:bg-gray-100"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            <NavLink to="/dashboard" className="flex items-center gap-2">
              <img src={logoIcon} alt="RoamReady" className="h-8 w-auto object-contain" />
              <span className="font-medium hidden sm:block">
                <span style={{ color: '#1E3A8A' }}>Roam</span><span style={{ color: '#EA6A0A' }}>ready</span><span style={{ color: '#1E3A8A' }}>.ai</span>
              </span>
            </NavLink>
          </div>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive ? 'bg-[#EFF6FF] text-[#1E3A8A] font-medium' : 'text-gray-600 hover:bg-gray-100'
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
            {user?.isOwner && (
              <NavLink to="/admin" className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-sm transition-colors ${isActive ? 'bg-[#EFF6FF] text-[#1E3A8A] font-medium' : 'text-gray-600 hover:bg-gray-100'}`
              }>Admin</NavLink>
            )}
          </nav>

          <div className="flex items-center gap-2">
            <button className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600">
              <Bell size={18} />
            </button>
            <div className="relative">
              <button
                onClick={() => setProfileOpen(!profileOpen)}
                className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg hover:bg-gray-100"
              >
                <div className="w-7 h-7 bg-[#1E3A8A] rounded-full flex items-center justify-center">
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
                  onBlur={() => setProfileOpen(false)}
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

      {/* Mobile sidebar */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-30 bg-black/30" onClick={() => setSidebarOpen(false)}>
          <div className="w-64 h-full bg-white border-r border-gray-200 pt-4 px-3" onClick={e => e.stopPropagation()}>
            <nav className="flex flex-col gap-1 mt-2">
              {navLinks.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setSidebarOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                      isActive ? 'bg-[#EFF6FF] text-[#1E3A8A] font-medium' : 'text-gray-600 hover:bg-gray-100'
                    }`
                  }
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
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 pt-6 pb-20 md:pb-6">
        <Outlet />
      </main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-40" style={{ borderTopWidth: '0.5px' }}>
        <div className="flex">
          {navLinks.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex-1 flex flex-col items-center py-2 gap-0.5 text-xs ${
                  isActive ? 'text-[#1E3A8A]' : 'text-gray-500'
                }`
              }
            >
              <Icon size={20} />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>

      <FeedbackButton onClick={openFeedbackModal} />
    </div>
  )
}
