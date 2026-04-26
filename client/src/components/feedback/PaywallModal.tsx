import { useState } from 'react'
import { X, Check, Zap } from 'lucide-react'
import { subscriptionsApi } from '../../services/api'

interface Props {
  feature?: string
  onClose: () => void
}

const FEATURE_LABELS: Record<string, string> = {
  campgroundBooking: 'Campground Booking',
  rigCompatibilityFilter: 'Rig Compatibility Filter',
  militaryCampgrounds: 'Military Campgrounds',
  ohvDestinations: 'OHV Destinations',
  vanDestinations: 'Van Life Destinations',
  pdfExport: 'PDF Export',
  tripSharing: 'Trip Sharing',
  resourcesAlongRoute: 'Resources Along Route',
  packingListGenerator: 'AI Packing List',
  tripJournal: 'Trip Journal',
  maintenanceTracker: 'Maintenance Tracker',
  weatherAlerts: 'Weather Alerts',
}

const PRO_FEATURES = [
  'Campground booking & reservations',
  'Rig compatibility filtering',
  'AI trip planner (unlimited)',
  'Weather alerts along route',
  'Trip journal with photos',
  'Maintenance tracker',
  'PDF export & trip sharing',
  'Military campground access',
]

export default function PaywallModal({ feature, onClose }: Props) {
  const [annual, setAnnual] = useState(true)
  const [loading, setLoading] = useState(false)

  const featureLabel = feature ? FEATURE_LABELS[feature] || feature : null

  async function handleUpgrade(plan: 'pro' | 'proplus') {
    setLoading(true)
    try {
      const priceId = annual
        ? (plan === 'pro' ? import.meta.env.VITE_STRIPE_PRO_ANNUAL : import.meta.env.VITE_STRIPE_PROPLUS_ANNUAL)
        : (plan === 'pro' ? import.meta.env.VITE_STRIPE_PRO_MONTHLY : import.meta.env.VITE_STRIPE_PROPLUS_MONTHLY)

      const res = await subscriptionsApi.createCheckout(priceId || 'price_placeholder')
      if (res.data.url) window.location.href = res.data.url
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30">
      <div className="bg-white rounded-xl border border-gray-200 w-full max-w-lg p-6" style={{ borderWidth: '0.5px' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[#E0F0F4] rounded-lg flex items-center justify-center">
              <Zap size={16} className="text-[#1F6F8B]" />
            </div>
            <div>
              <h2 className="font-medium text-gray-900">Upgrade to Pro</h2>
              {featureLabel && <p className="text-xs text-gray-500">{featureLabel} requires Pro</p>}
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100"><X size={18} /></button>
        </div>

        <div className="flex items-center justify-center mb-6">
          <div className="bg-gray-100 rounded-lg p-0.5 flex">
            <button
              onClick={() => setAnnual(false)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${!annual ? 'bg-white text-gray-900' : 'text-gray-500'}`}
            >Monthly</button>
            <button
              onClick={() => setAnnual(true)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${annual ? 'bg-white text-gray-900' : 'text-gray-500'}`}
            >
              Annual <span className="text-[#1F6F8B] ml-1">Save 35%</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="border border-[#1F6F8B] rounded-xl p-4" style={{ borderWidth: '0.5px' }}>
            <div className="text-sm font-medium text-[#1F6F8B] mb-1">Pro</div>
            <div className="text-2xl font-medium text-gray-900">
              ${annual ? '5.83' : '8.99'}
              <span className="text-sm text-gray-500 font-normal">/mo</span>
            </div>
            {annual && <div className="text-xs text-gray-500">$69.99 billed annually</div>}
            <button
              onClick={() => handleUpgrade('pro')}
              disabled={loading}
              className="btn-primary w-full mt-3 text-sm"
            >
              Start free trial
            </button>
          </div>
          <div className="border border-gray-200 rounded-xl p-4" style={{ borderWidth: '0.5px' }}>
            <div className="text-sm font-medium text-gray-500 mb-1">Pro+</div>
            <div className="text-2xl font-medium text-gray-900">
              ${annual ? '9.17' : '12.99'}
              <span className="text-sm text-gray-500 font-normal">/mo</span>
            </div>
            {annual && <div className="text-xs text-gray-500">$109.99 billed annually</div>}
            <button
              onClick={() => handleUpgrade('proplus')}
              disabled={loading}
              className="btn-outline w-full mt-3 text-sm"
            >
              Start free trial
            </button>
          </div>
        </div>

        <ul className="space-y-2 mb-4">
          {PRO_FEATURES.map(f => (
            <li key={f} className="flex items-center gap-2 text-sm text-gray-600">
              <Check size={14} className="text-[#1F6F8B] flex-shrink-0" />
              {f}
            </li>
          ))}
        </ul>

        <p className="text-xs text-center text-gray-400">
          7-day free trial • No credit card required • Cancel anytime
        </p>
      </div>
    </div>
  )
}
