import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Check, Zap, Info } from 'lucide-react'
import { subscriptionsApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { PRO_FEATURES } from '../../config/pricing'

interface Props {
  feature?: string
  /** Optional route to navigate to when the user dismisses the modal.
   *  Set by Pro-only pages where the content behind the modal is an
   *  empty shell (OhvDestinationsPage / VanDestinationsPage /
   *  TripBookingPage) so dismissing doesn't strand the user. When unset,
   *  dismissing just closes the modal and leaves the user on the current
   *  page (the right behavior when the modal was layered over usable
   *  free content). */
  redirectOnDismiss?: string
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
  proMonthly:        import.meta.env.VITE_STRIPE_PRO_MONTHLY,
  proAnnual:         import.meta.env.VITE_STRIPE_PRO_ANNUAL,
  proFounderMonthly: import.meta.env.VITE_STRIPE_PRO_FOUNDER_MONTHLY,
  proFounderAnnual:  import.meta.env.VITE_STRIPE_PRO_FOUNDER_ANNUAL,
} as const

function isUsablePriceId(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v !== 'price_placeholder'
}

// BILLING_CONFIGURED gates on the REGULAR price IDs only — they're the
// public-facing baseline that every PaywallModal viewer can fall back to.
// The founder price IDs may legitimately be unset in a build that doesn't
// participate in the founder promo (e.g. a future relaunch); we don't want
// missing founder vars to disable billing for regular users.
const BILLING_CONFIGURED =
  isUsablePriceId(PRICE_IDS.proMonthly) &&
  isUsablePriceId(PRICE_IDS.proAnnual)

/** Mirrors PricingPage.tsx: founder users see $7.99/mo ($69.99/yr); regular
 *  users see $8.99/mo ($89.99/yr). Keep these two locations in sync. */
const FOUNDER_DISPLAY = { monthly: '7.99', annualPerMo: '5.83', annualBilled: '69.99' }
const REGULAR_DISPLAY = { monthly: '8.99', annualPerMo: '7.49', annualBilled: '89.99' }

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
  // Block 9 — added so a 403 from requireFeature('aiPlannerUnlimited') (the
  // new umbrella gate on /ai/chat, /ai/generate-itinerary, and the three
  // /trips/:id/(itinerary|activities)/generate + .../highlights routes)
  // renders as "Unlock AI Trip Planner" instead of the raw key string.
  aiPlannerUnlimited: 'AI Trip Planner',
}

export default function PaywallModal({ feature, redirectOnDismiss, onClose }: Props) {
  const navigate = useNavigate()
  const [annual, setAnnual] = useState(true)
  const [loading, setLoading] = useState(false)
  const user = useAuthStore(s => s.user)

  const featureLabel = feature ? FEATURE_LABELS[feature] || feature : null

  // Dismiss handler — navigate first (if the caller set a redirect target),
  // then close the modal. Navigate-first ordering matters because closing
  // the modal triggers unmount, and we want the route change to land
  // before the modal disappears so the user perceives one continuous
  // transition rather than blank-page-then-redirect.
  function handleDismiss() {
    if (redirectOnDismiss) navigate(redirectOnDismiss)
    onClose()
  }

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
        'VITE_STRIPE_PRO_MONTHLY, VITE_STRIPE_PRO_ANNUAL'
      )
    }
  }, [])

  async function handleUpgrade(_plan: 'pro') {
    // Defense in depth — buttons are disabled when BILLING_CONFIGURED is false,
    // but guard anyway so a stale/cached UI can never push a placeholder string
    // to Stripe. The whole reason this fix exists is to never have that happen.
    if (!BILLING_CONFIGURED) return

    setLoading(true)
    try {
      // Founder users get the founder-rate priceId; the server-side
      // FOUNDER_INELIGIBLE guard in createCheckout rejects any attempt to
      // submit a founder priceId from a non-founder account, so this is
      // safe-by-default even with stale/cached state.
      const priceId = user?.founderPricing
        ? (annual ? PRICE_IDS.proFounderAnnual : PRICE_IDS.proFounderMonthly)
        : (annual ? PRICE_IDS.proAnnual         : PRICE_IDS.proMonthly)

      const res = await subscriptionsApi.createCheckout(priceId)
      if (res.data.url) window.location.href = res.data.url
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  // Effective display prices — mirrors effectiveProPricing() in PricingPage.tsx.
  const display = user?.founderPricing ? FOUNDER_DISPLAY : REGULAR_DISPLAY
  // Save N% — computed from the prices the user actually sees, matching the
  // PricingPage formula: 1 - (annualBilled / (monthlyPrice * 12)).
  const savePct = Math.round(
    (1 - parseFloat(display.annualBilled) / (parseFloat(display.monthly) * 12)) * 100,
  )

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
          <button onClick={handleDismiss} className="p-1 rounded-lg hover:bg-gray-100"><X size={18} /></button>
        </div>

        {/* Toggle mirrors PricingPage's premium-feel treatment — see that
            file for the design rationale. */}
        <div className="flex items-center justify-center mb-6">
          <div
            className="inline-flex items-center rounded-full p-1"
            style={{ backgroundColor: '#F1EFE8', border: '0.5px solid #E8E4DA' }}
          >
            <button
              onClick={() => setAnnual(false)}
              className={`px-4 py-1.5 rounded-full text-sm transition-colors ${
                !annual ? 'bg-[#1F6F8B] text-white font-medium' : 'bg-transparent text-[#5F5E5A] hover:text-[#2C2C2A]'
              }`}
            >Monthly</button>
            <button
              onClick={() => setAnnual(true)}
              className={`px-4 py-1.5 rounded-full text-sm transition-colors ${
                annual ? 'bg-[#1F6F8B] text-white font-medium' : 'bg-transparent text-[#5F5E5A] hover:text-[#2C2C2A]'
              }`}
            >
              Annual <span className="ml-1" style={{ color: annual ? '#FAC775' : '#0F766E' }}>Save {savePct}%</span>
            </button>
          </div>
        </div>

        {/* Single Pro card (Pro+ tier was removed). The grid wrapper from
            the prior two-card layout is gone — a single card renders
            full-width inside the modal, which reads cleaner than a
            half-width card with empty space beside it. */}
        <div className="mb-6">
          {/* 2px Sunset Gold border mirrors PricingPage's Pro card — the
              single "premium" signal without any marketing-badge SaaS-speak.
              CTA below uses btn-primary (gold fill, white text, gold-darker
              on hover) which already matches the spec exactly. */}
          <div className="rounded-xl p-4" style={{ border: '2px solid #F7A829' }}>
            <div className="text-sm font-medium text-[#1F6F8B] mb-1">Pro</div>
            {/* Same tagline as PricingPage's Pro card description, kept in
                sync manually (no shared constant yet — backlog candidate). */}
            <p className="text-xs text-gray-500 mb-2">Everything you need for a great trip.</p>
            <div className="text-2xl font-medium text-gray-900">
              ${annual ? display.annualPerMo : display.monthly}
              <span className="text-sm text-gray-500 font-normal">/mo</span>
            </div>
            {annual && <div className="text-xs text-gray-500">${display.annualBilled} billed annually</div>}
            {/* Lifetime-locked founder rate badge — mirrors PricingPage.
                Info icon + native title= for desktop hover; one-line caveat
                below for the mobile case where title tooltips don't fire. */}
            {user?.founderPricing && (
              <div className="mt-1">
                <p
                  className="text-xs text-[#1F6F8B] font-medium inline-flex items-center gap-1 cursor-help"
                  title="Stay subscribed to keep this rate. If you cancel and rejoin later, you'll pay the regular price at that time."
                >
                  Lifetime founder rate
                  <Info size={12} aria-hidden="true" />
                </p>
                <p className="text-[11px] text-[#5F5E5A] mt-0.5">
                  Stay subscribed to keep this rate.
                </p>
              </div>
            )}
            <button
              onClick={() => handleUpgrade('pro')}
              disabled={loading || !BILLING_CONFIGURED}
              className="btn-primary w-full mt-3 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ctaText('Pro')}
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
