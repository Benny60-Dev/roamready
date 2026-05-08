import { useEffect, useState } from 'react'
import { X, Check, Zap } from 'lucide-react'
import { subscriptionsApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'

interface Props {
  feature?: string
  onClose: () => void
}

// Stripe price IDs are baked into the client bundle at Vite build time. If any
// of the four are missing / empty / still set to a placeholder string, billing
// is not safely usable from this build — disable the upgrade buttons and surface
// an inline message rather than letting clicks reach Stripe with bogus data.
//
// Pulled out of the component body since these values are constant for the life
// of the bundle. Same pattern is duplicated in PricingPage.tsx — flag for a
// follow-up that extracts a shared `useBillingConfig()` hook.
const PRICE_IDS = {
  proMonthly:     import.meta.env.VITE_STRIPE_PRO_MONTHLY,
  proAnnual:      import.meta.env.VITE_STRIPE_PRO_ANNUAL,
  proplusMonthly: import.meta.env.VITE_STRIPE_PROPLUS_MONTHLY,
  proplusAnnual:  import.meta.env.VITE_STRIPE_PROPLUS_ANNUAL,
} as const

function isUsablePriceId(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v !== 'price_placeholder'
}

const BILLING_CONFIGURED =
  isUsablePriceId(PRICE_IDS.proMonthly) &&
  isUsablePriceId(PRICE_IDS.proAnnual) &&
  isUsablePriceId(PRICE_IDS.proplusMonthly) &&
  isUsablePriceId(PRICE_IDS.proplusAnnual)

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
  const user = useAuthStore(s => s.user)

  const featureLabel = feature ? FEATURE_LABELS[feature] || feature : null

  // Trial eligibility — user has never started a trial AND has no Stripe
  // customer record. Both fields are nullable on the User row; either one
  // being set means we've already seen this user in the billing system, so
  // they don't get the "free trial" framing again.
  //   - trialEndsAt: set when a trial starts (active or expired afterwards)
  //   - customerId: set after the first Stripe checkout completes
  // The cancellation grace path (subscriptionEndsAt set, tier flipped to FREE)
  // also blocks trial eligibility because customerId is still populated.
  const trialEligible = !user?.trialEndsAt && !user?.customerId
  const ctaText = (planLabel: string) => trialEligible ? 'Start free trial' : `Upgrade to ${planLabel}`
  const footerText = trialEligible
    ? '7-day free trial • No credit card required • Cancel anytime'
    : 'Cancel anytime'

  // One-time mount log when the modal opens against an unconfigured build —
  // visible in production logs (Sentry once installed, console for now) so the
  // ops surface knows the Stripe env vars are missing. The user-facing message
  // below the prices handles UX; this is for the engineer.
  useEffect(() => {
    if (!BILLING_CONFIGURED) {
      console.error(
        'PaywallModal: Stripe price IDs missing from build env. Required: ' +
        'VITE_STRIPE_PRO_MONTHLY, VITE_STRIPE_PROPLUS_MONTHLY, ' +
        'VITE_STRIPE_PRO_ANNUAL, VITE_STRIPE_PROPLUS_ANNUAL'
      )
    }
  }, [])

  async function handleUpgrade(plan: 'pro' | 'proplus') {
    // Defense in depth — buttons are disabled when BILLING_CONFIGURED is false,
    // but guard anyway so a stale/cached UI can never push a placeholder string
    // to Stripe. The whole reason this fix exists is to never have that happen.
    if (!BILLING_CONFIGURED) return

    setLoading(true)
    try {
      const priceId = annual
        ? (plan === 'pro' ? PRICE_IDS.proAnnual : PRICE_IDS.proplusAnnual)
        : (plan === 'pro' ? PRICE_IDS.proMonthly : PRICE_IDS.proplusMonthly)

      const res = await subscriptionsApi.createCheckout(priceId)
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
              <h2 className="font-medium text-gray-900">
                {featureLabel ? `Unlock ${featureLabel}` : 'Unlock Pro features'}
              </h2>
              <p className="text-xs text-gray-500">Available with Pro</p>
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
              disabled={loading || !BILLING_CONFIGURED}
              className="btn-primary w-full mt-3 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ctaText('Pro')}
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
              disabled={loading || !BILLING_CONFIGURED}
              className="btn-outline w-full mt-3 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ctaText('Pro+')}
            </button>
          </div>
        </div>

        {/* Billing-not-configured banner — only shown when one or more of the
            four Stripe price IDs is missing / empty / placeholder in this build.
            Replaces the silent 'price_placeholder' fallback that used to send
            bogus IDs to Stripe; now the user gets an explicit message and an
            ops contact route instead of a stuck loader. */}
        {!BILLING_CONFIGURED && (
          <div className="mb-4 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 text-center" style={{ borderWidth: '0.5px' }}>
            Billing temporarily unavailable. Please contact support.
          </div>
        )}

        <ul className="space-y-2 mb-4">
          {PRO_FEATURES.map(f => (
            <li key={f} className="flex items-center gap-2 text-sm text-gray-600">
              <Check size={14} className="text-[#1F6F8B] flex-shrink-0" />
              {f}
            </li>
          ))}
        </ul>

        <p className="text-xs text-center text-gray-400">
          {footerText}
        </p>
      </div>
    </div>
  )
}
