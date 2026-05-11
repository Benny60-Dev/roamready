import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import { subscriptionsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import type { User } from '../types'

/** Maps a PLANS entry's id to the tier string stored on user.subscriptionTier. */
const PLAN_TIER: Record<string, 'PRO' | null> = {
  free: null,
  pro: 'PRO',
}

/** Display label for the paid plans (used in CTA copy). */
const PLAN_LABEL: Record<string, string> = {
  pro: 'Pro',
}

/** Returns the CTA label + disabled state for a paid-plan card based on
 *  what clicking it would actually do for THIS user. Five states:
 *
 *  1. Not logged in                                  → "Start free trial"
 *  2. Logged in, app-side trial still active         → "Lock in Pro[+]"
 *     (encourages upgrading without losing the in-app trial framing)
 *  3. Logged in, trial expired, no paid sub          → "Upgrade to Pro[+]"
 *  4. Logged in, currently subscribed to THIS tier   → "Current plan", disabled
 *  5. Logged in, currently subscribed to OTHER tier  → "Switch to Pro[+]"
 *
 *  The Free card has its own ctaTo='/signup' and is handled separately. */
function getCta(planId: string, user: User | null): { label: string; disabled: boolean } {
  const tierForThisCard = PLAN_TIER[planId]
  const planLabel = PLAN_LABEL[planId] ?? planId

  // Free card — caller handles via its own ctaTo branch; never reaches here.
  if (!tierForThisCard) return { label: 'Get started', disabled: false }

  if (!user) return { label: 'Start free trial', disabled: false }

  // Already on this exact tier — don't offer to re-buy. Disabled.
  if (user.subscriptionTier === tierForThisCard) {
    return { label: 'Current plan', disabled: true }
  }

  // (Future-tier note: when a second paid tier returns, add an
  // "already paid for the OTHER tier" branch here that returns
  // "Switch to ${planLabel}". With only one paid tier today, the
  // check above already catches every paid-user case, so a dedicated
  // switch branch would be dead code.)

  // FREE tier from here on. Distinguish "still in app-side trial" from
  // "trial expired / never had one" so the copy nudges the right action.
  const trialActive =
    !!user.trialEndsAt && new Date(user.trialEndsAt) > new Date()

  return {
    label: trialActive ? `Lock in ${planLabel}` : `Upgrade to ${planLabel}`,
    disabled: false,
  }
}

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
    annualPrice: 7.49,     // $89.99 / 12 = $7.4992 — per-month equivalent
    annualBilled: 89.99,
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
    // CTA computed at render time via getCta(). The literal here is unused
    // for paid plans — kept only so PLANS rows have a uniform shape with
    // the Free row's `cta`.
    cta: 'Upgrade to Pro',
    highlight: true,
  },
]

export default function PricingPage() {
  // Defaults to MONTHLY so the displayed price ($8.99 Pro) is what the
  // user is actually charged on the first invoice. Annual remains one
  // click away — and when selected, both the per-month equivalent AND
  // the annual total are shown side-by-side (see the price-display
  // block below) to avoid the surprise charge that happened the first
  // time we shipped this with annual default.
  const [annual, setAnnual] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const { user, isAuthenticated } = useAuthStore()

  async function handleUpgrade(planId: string) {
    if (!isAuthenticated()) return
    setLoading(planId)
    // Pro is currently the only paid tier; the planId argument exists so
    // a future second tier (e.g. Pro+ Family) is a one-line addition here.
    const priceId = annual
      ? import.meta.env.VITE_STRIPE_PRO_ANNUAL
      : import.meta.env.VITE_STRIPE_PRO_MONTHLY

    try {
      // Mirror PaywallModal's isUsablePriceId guard. If the env var is missing
      // or set to a placeholder, the previous code would forward the literal
      // string 'price_placeholder' to the server, which forwarded it to
      // Stripe and produced "No such price: 'price_placeholder'" — a
      // dead-end UX. Instead: refuse client-side, log, and tell the user
      // billing isn't configured. The server now ALSO rejects placeholders
      // (defense in depth), but this client-side check keeps the failure
      // surface friendly and avoids a network round-trip.
      if (!priceId || typeof priceId !== 'string' || priceId === 'price_placeholder') {
        console.error('[Pricing] Missing/placeholder VITE_STRIPE_* env var for', planId, annual ? 'annual' : 'monthly')
        alert('Billing is not configured. Please contact support.')
        return
      }
      const res = await subscriptionsApi.createCheckout(priceId)
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
          <p className="text-gray-500 mb-6">7 days free, no card required to start. Add a card anytime to lock in Pro features.</p>
          <div className="inline-flex items-center bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setAnnual(false)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${!annual ? 'bg-white text-gray-900' : 'text-gray-500'}`}
            >Monthly</button>
            <button
              onClick={() => setAnnual(true)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${annual ? 'bg-white text-gray-900' : 'text-gray-500'}`}
            >
              Annual <span className="text-[#0F766E] ml-1">Save 17%</span>
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
                {/* When the Annual toggle is on, the big number above is the
                    per-month EQUIVALENT (marketing hook). The line below is
                    what's actually charged today. Typography matches the
                    feature-list rows further down (text-sm text-gray-600)
                    so the user sees both numbers at the same glance — not
                    one prominent number and one footnote. */}
                {annual && plan.annualBilled && (
                  <p className="text-sm text-gray-600 mt-1">${plan.annualBilled} billed annually</p>
                )}
              </div>

              {plan.ctaTo ? (
                <Link to={plan.ctaTo} className={`block text-center py-2.5 rounded-lg text-sm font-medium mb-6 ${plan.highlight ? 'btn-primary' : 'btn-outline'}`}>
                  {plan.cta}
                </Link>
              ) : (() => {
                // Per-render CTA — derived from current user state. The
                // literal `plan.cta` from PLANS is intentionally ignored for
                // paid plans (see comment on the PLANS entry).
                const cta = getCta(plan.id, user)
                return (
                  <button
                    onClick={() => handleUpgrade(plan.id)}
                    disabled={loading === plan.id || cta.disabled}
                    className={`w-full py-2.5 rounded-lg text-sm font-medium mb-6 transition-colors ${
                      plan.highlight ? 'bg-[#F7A829] text-white hover:bg-[#C9851A]' : 'border border-[#1F6F8B] text-[#1F6F8B] hover:bg-[#E0F0F4]'
                    } disabled:opacity-40`}
                    style={{ borderWidth: '0.5px' }}
                  >
                    {loading === plan.id ? 'Loading...' : cta.label}
                  </button>
                )
              })()}

              <ul className="space-y-2">
                {plan.features.map(feature => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-gray-600">
                    <Check size={14} className="text-[#1F6F8B] flex-shrink-0 mt-0.5" />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-gray-400 mt-8">
          Start your 7-day free trial • Cancel anytime • Secure payment via Stripe
        </p>
      </div>
    </div>
  )
}
