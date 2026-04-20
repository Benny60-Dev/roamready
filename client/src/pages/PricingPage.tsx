import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import { subscriptionsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    monthlyPrice: 0,
    annualPrice: 0,
    description: 'Get started planning',
    features: [
      'AI trip planner (3/month)',
      '1 rig profile',
      'Basic trip planning',
      'Map view',
    ],
    cta: 'Get started',
    ctaTo: '/signup',
    highlight: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    monthlyPrice: 8.99,
    annualPrice: 5.83,
    annualBilled: 69.99,
    description: 'Everything you need',
    features: [
      'AI trip planner (unlimited)',
      'Rig compatibility filtering',
      'Campground booking',
      'Military campground access',
      'OHV & van destinations',
      'Weather alerts',
      'Trip journal with photos',
      'Maintenance tracker',
      'PDF export & sharing',
      'Resources along route',
      'Packing list generator',
      'Membership auto-apply',
    ],
    cta: 'Start 7-day free trial',
    highlight: true,
  },
  {
    id: 'proplus',
    name: 'Pro+',
    monthlyPrice: 12.99,
    annualPrice: 9.17,
    annualBilled: 109.99,
    description: 'For the full-time traveler',
    features: [
      'Everything in Pro',
      'Multiple rig profiles',
      'Offline access',
      'Family account',
      'RV recall alerts',
      'Cost analytics',
      'Unlimited trip journal',
      'Priority support',
    ],
    cta: 'Start 7-day free trial',
    highlight: false,
  },
]

export default function PricingPage() {
  const [annual, setAnnual] = useState(true)
  const [loading, setLoading] = useState<string | null>(null)
  const { user, isAuthenticated } = useAuthStore()

  async function handleUpgrade(planId: string) {
    if (!isAuthenticated()) return
    setLoading(planId)
    const priceId = annual
      ? (planId === 'pro' ? import.meta.env.VITE_STRIPE_PRO_ANNUAL : import.meta.env.VITE_STRIPE_PROPLUS_ANNUAL)
      : (planId === 'pro' ? import.meta.env.VITE_STRIPE_PRO_MONTHLY : import.meta.env.VITE_STRIPE_PROPLUS_MONTHLY)

    try {
      const res = await subscriptionsApi.createCheckout(priceId || 'price_placeholder')
      if (res.data.url) window.location.href = res.data.url
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-5xl mx-auto px-4 py-16">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-medium text-gray-900 mb-2">Simple, transparent pricing</h1>
          <p className="text-gray-500 mb-6">Start with a 7-day free trial. No credit card required.</p>
          <div className="inline-flex items-center bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setAnnual(false)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${!annual ? 'bg-white text-gray-900' : 'text-gray-500'}`}
            >Monthly</button>
            <button
              onClick={() => setAnnual(true)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${annual ? 'bg-white text-gray-900' : 'text-gray-500'}`}
            >
              Annual <span className="text-[#0F766E] ml-1">Save 35%</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map(plan => (
            <div
              key={plan.id}
              className={`rounded-xl border p-6 ${plan.highlight ? 'border-[#EA6A0A] bg-[#FFF7ED]/20' : 'border-gray-200 bg-white'}`}
              style={{ borderWidth: '0.5px' }}
            >
              {plan.highlight && <div className="badge-green text-xs mb-3">Most popular</div>}
              <h2 className="font-medium text-gray-900 text-lg mb-0.5">{plan.name}</h2>
              <p className="text-xs text-gray-500 mb-4">{plan.description}</p>

              <div className="mb-6">
                <div className="text-3xl font-medium text-gray-900">
                  {plan.monthlyPrice === 0 ? 'Free' : (
                    <>
                      ${annual ? plan.annualPrice : plan.monthlyPrice}
                      <span className="text-sm font-normal text-gray-500">/mo</span>
                    </>
                  )}
                </div>
                {annual && plan.annualBilled && (
                  <p className="text-xs text-gray-400 mt-0.5">${plan.annualBilled}/year</p>
                )}
              </div>

              {plan.ctaTo ? (
                <Link to={plan.ctaTo} className={`block text-center py-2.5 rounded-lg text-sm font-medium mb-6 ${plan.highlight ? 'btn-primary' : 'btn-outline'}`}>
                  {plan.cta}
                </Link>
              ) : (
                <button
                  onClick={() => handleUpgrade(plan.id)}
                  disabled={loading === plan.id || user?.subscriptionTier === plan.id.replace('plus', '_PLUS').toUpperCase()}
                  className={`w-full py-2.5 rounded-lg text-sm font-medium mb-6 transition-colors ${
                    plan.highlight ? 'bg-[#EA6A0A] text-white hover:bg-[#C2580A]' : 'border border-[#1E3A8A] text-[#1E3A8A] hover:bg-[#EFF6FF]'
                  } disabled:opacity-40`}
                  style={{ borderWidth: '0.5px' }}
                >
                  {loading === plan.id ? 'Loading...' : plan.cta}
                </button>
              )}

              <ul className="space-y-2">
                {plan.features.map(feature => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-gray-600">
                    <Check size={14} className="text-[#1E3A8A] flex-shrink-0 mt-0.5" />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-gray-400 mt-8">
          All plans include a 7-day free trial • Cancel anytime • Secure payment via Stripe
        </p>
      </div>
    </div>
  )
}
