import { Link } from 'react-router-dom'
import { MapPin, Zap, Shield, Users, Truck, Wind, Compass, Check, ChevronRight } from 'lucide-react'
import logoIcon from '../assets/logo-icon.png'
import SplashScreen from '../components/SplashScreen'

const VEHICLE_TYPES = [
  {
    id: 'rv',
    emoji: '🚌',
    title: 'RV & Motorhome',
    subtitle: 'Class A, B, C, Fifth Wheel, Travel Trailer',
    features: ['Rig compatibility filtering', 'Full hookup routing', 'Dump station locator'],
  },
  {
    id: 'van',
    emoji: '🚐',
    title: 'Van Life',
    subtitle: 'Converted vans, camper vans, Sprinters',
    features: ['BLM & dispersed camping', 'Stealth spots', 'Harvest Hosts access'],
  },
  {
    id: 'car',
    emoji: '🏕️',
    title: 'Car Camping',
    subtitle: 'Tent camping, overlanding, backpacking',
    features: ['Walk-in & backcountry sites', 'Permit tracker', 'Gear-based packing lists'],
  },
]

const FEATURES = [
  { icon: Zap, title: 'AI Trip Planner', desc: 'Chat with Claude to build the perfect itinerary in minutes.' },
  { icon: MapPin, title: 'Interactive Maps', desc: 'See your full route with campground pins and weather overlays.' },
  { icon: Shield, title: 'Rig Compatibility', desc: 'Never arrive at a campground your rig can\'t fit.' },
  { icon: Users, title: 'Trip Sharing', desc: 'Share read-only itineraries with friends and family.' },
  { icon: Truck, title: 'Maintenance Tracker', desc: 'Stay ahead of oil changes, roof seals, and more.' },
  { icon: Wind, title: 'Weather Alerts', desc: 'Get forecasts for every stop before you leave home.' },
  { icon: Compass, title: 'Resources En Route', desc: 'Find RV repair, propane, dump stations, and vets.' },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      <SplashScreen />
      {/* Nav */}
      <header className="sticky top-0 z-40 bg-white border-b border-gray-100" style={{ borderBottomWidth: '0.5px' }}>
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src={logoIcon} alt="RoamReady" className="h-8 w-auto object-contain" />
            <span className="font-medium">
              <span style={{ color: '#1F6F8B' }}>Roam</span><span style={{ color: '#F7A829' }}>ready</span><span style={{ color: '#1F6F8B' }}>.ai</span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/pricing" className="hidden sm:inline text-sm text-gray-600 hover:text-gray-900">Pricing</Link>
            <Link to="/roadmap" className="hidden sm:inline text-sm text-gray-600 hover:text-gray-900">Roadmap</Link>
            <Link to="/login" className="text-sm text-gray-600 hover:text-gray-900">Sign in</Link>
            <Link to="/signup" className="btn-primary text-sm">Get started free</Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-1.5 bg-[#E0F0F4] text-[#134756] px-3 py-1 rounded-full text-sm mb-6">
          <Zap size={13} />
          Powered by Claude AI
        </div>
        <h1 className="text-4xl sm:text-5xl font-medium text-gray-900 mb-4 leading-tight">
          Plan your next adventure<br />
          <span className="text-[#1F6F8B]">in minutes, not days</span>
        </h1>
        <p className="text-lg text-gray-500 mb-8 max-w-2xl mx-auto">
          AI-powered trip planning for RV travelers, van lifers, and car campers.
          Rig-compatible campgrounds, weather alerts, packing lists, and more.
        </p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <Link to="/signup" className="btn-primary px-6 py-3 text-base flex items-center gap-2">
            Start planning free <ChevronRight size={16} />
          </Link>
          <Link to="/sessions/new" className="btn-outline px-6 py-3 text-base">
            Try the AI planner
          </Link>
        </div>
        <p className="text-xs text-gray-400 mt-3">7-day free trial • No credit card required</p>
      </section>

      {/* Vehicle type selector */}
      <section className="max-w-6xl mx-auto px-4 pb-20">
        <h2 className="text-2xl font-medium text-center text-gray-900 mb-2">Built for your rig</h2>
        <p className="text-gray-500 text-center mb-10">RoamReady adapts to how you travel.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {VEHICLE_TYPES.map(v => (
            <Link
              key={v.id}
              to="/signup"
              className="card-lg hover:border-[#1F6F8B] hover:border-opacity-50 transition-all group"
            >
              <div className="text-4xl mb-3">{v.emoji}</div>
              <h3 className="font-medium text-gray-900 mb-0.5">{v.title}</h3>
              <p className="text-sm text-gray-500 mb-4">{v.subtitle}</p>
              <ul className="space-y-1.5">
                {v.features.map(f => (
                  <li key={f} className="flex items-center gap-2 text-sm text-gray-600">
                    <Check size={13} className="text-[#1F6F8B]" />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-4 text-[#1F6F8B] text-sm font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                Get started <ChevronRight size={14} />
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="bg-gray-50 py-20">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-2xl font-medium text-center text-gray-900 mb-2">Everything you need</h2>
          <p className="text-gray-500 text-center mb-10">One app for the entire trip lifecycle.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="card">
                <div className="w-8 h-8 bg-[#E0F0F4] rounded-lg flex items-center justify-center mb-3">
                  <Icon size={16} className="text-[#1F6F8B]" />
                </div>
                <h3 className="font-medium text-gray-900 mb-1">{title}</h3>
                <p className="text-sm text-gray-500">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-6xl mx-auto px-4 py-20 text-center">
        <h2 className="text-3xl font-medium text-gray-900 mb-3">Ready to hit the road?</h2>
        <p className="text-gray-500 mb-8 max-w-xl mx-auto">
          Join thousands of travelers planning smarter with RoamReady.
        </p>
        <Link to="/signup" className="btn-primary px-8 py-3 text-base inline-flex items-center gap-2">
          Start your free trial <ChevronRight size={16} />
        </Link>
      </section>

      <footer className="border-t border-gray-100 py-8" style={{ borderTopWidth: '0.5px' }}>
        <div className="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-sm text-gray-400">© 2026 Martini AI Media LLC. All rights reserved.</span>
          <div className="flex items-center gap-4">
            <Link to="/pricing" className="text-sm text-gray-400 hover:text-gray-600">Pricing</Link>
            <Link to="/roadmap" className="text-sm text-gray-400 hover:text-gray-600">Roadmap</Link>
            <Link to="/privacy" className="text-sm text-gray-400 hover:text-gray-600">Privacy Policy</Link>
            <Link to="/terms" className="text-sm text-gray-400 hover:text-gray-600">Terms of Service</Link>
            <Link to="/login" className="text-sm text-gray-400 hover:text-gray-600">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
