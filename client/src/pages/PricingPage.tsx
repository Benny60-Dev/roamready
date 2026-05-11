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

/** Founder-rate Pro pricing — lifetime-locked for users who signed up
 *  before FOUNDER_CUTOFF_DATE (server-side flag on user.founderPricing).
 *  Mirrors the shape of the PLANS Pro entry's price fields. */
const FOUNDER_PRO_PRICING = {
  monthlyPrice: 7.99,
  annualPrice: 5.83,     // $69.99 / 12 = $5.8325 — per-month equivalent
  annualBilled: 69.99,
} as const

/** Returns the effective pricing for the Pro card based on user state.
 *  Founder users see FOUNDER_PRO_PRICING; everyone else (including
 *  logged-out visitors) sees the regular prices baked into the PLANS
 *  entry. */
function effectiveProPricing(user: User | null) {
  return user?.founderPricing
    ? FOUNDER_PRO_PRICING
    : { monthlyPrice: 8.99, annualPrice: 7.49, annualBilled: 89.99 }
}

/** Annual-vs-monthly savings percentage, rounded to nearest whole. Used
 *  for the "Save N%" toggle badge so the displayed number always matches
 *  the prices actually shown on the card. */
function annualSavingsPct(p: { monthlyPrice: number; annualBilled: number }) {
  return Math.round((1 - p.annualBilled / (p.monthlyPrice * 12)) * 100)
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

/** A feature item is either a plain string (rendered as a bullet) or a
 *  section object — title + bullets. Sections let the Free card show
 *  the 7-day Pro trial value AND post-trial features in two clearly
 *  labeled groups; the Pro card keeps the simpler flat-string shape.
 *  Discriminated at render time by `typeof item === 'string'`. */
type FeatureSection = { sectionLabel: string; items: string[] }
type FeatureItem = string | FeatureSection

const PLANS: Array<{
  id: string
  name: string
  monthlyPrice: number
  annualPrice: number
  annualBilled?: number
  description: string
  features: FeatureItem[]
  cta: string
  ctaTo?: string
  highlight: boolean
}> = [
  {
    id: 'free',
    name: 'Free',
    monthlyPrice: 0,
    annualPrice: 0,
    description: 'Start with everything, no card required.',
    features: [
      {
        sectionLabel: 'Includes a 7-day Pro trial:',
        items: [
          'AI trip planner',
          'Campground booking',
          'Trip journal with photos',
          'Maintenance tracker',
          'PDF export & sharing',
          'And much more',
        ],
      },
      {
        sectionLabel: 'After trial:',
        items: [
          'AI trip planner',
          'Rig profiles',
          'Trip planning',
          'Map view',
        ],
      },
    ],
    cta: 'Get started',
    ctaTo: '/signup',
    highlight: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    // Regular Pro prices — used for non-founder users (and as the public-
    // facing default for logged-out visitors). Founder users see
    // FOUNDER_PRO_PRICING (defined below) overlaid at render time.
    monthlyPrice: 8.99,
    annualPrice: 7.49,     // $89.99 / 12 = $7.4992 — per-month equivalent
    annualBilled: 89.99,
    description: 'Everything you need for a great trip.',
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
    // No `highlight` flag — with a single paid tier, visually elevating
    // the Pro card over Free reads as marketing-by-default. Both cards
    // share the same neutral border/styling now.
    highlight: false,
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

  // Effective Pro pricing for THIS viewer — founder rates for users with
  // user.founderPricing === true, regular rates for everyone else.
  const proPricing = effectiveProPricing(user)
  // Annual-toggle "Save N%" badge text reflects the prices the user
  // actually sees: founders save ~27%, regular users save ~17%.
  const savePct = annualSavingsPct(proPricing)

  async function handleUpgrade(planId: string) {
    if (!isAuthenticated()) return
    setLoading(planId)
    // Pro is currently the only paid tier; the planId argument exists so
    // a future second tier (e.g. Pro+ Family) is a one-line addition here.
    // Founder users get the founder-rate priceId; the server-side check
    // in createCheckout (FOUNDER_INELIGIBLE guard) rejects any attempt to
    // submit a founder priceId from a non-founder account.
    const priceId = user?.founderPricing
      ? (annual
          ? import.meta.env.VITE_STRIPE_PRO_FOUNDER_ANNUAL
          : import.meta.env.VITE_STRIPE_PRO_FOUNDER_MONTHLY)
      : (annual
          ? import.meta.env.VITE_STRIPE_PRO_ANNUAL
          : import.meta.env.VITE_STRIPE_PRO_MONTHLY)

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
          {/* Selection state is solid RV Blue + white text — clearly readable
              at a glance. Inactive is transparent on the neutral pill
              backdrop with muted gray text. The "Save N%" suffix on the
              Annual button uses a light-gold accent (#FAC775) when active
              (gold pops on blue) and falls back to teal (#0F766E) when
              inactive so the savings hook stays visible to users still
              looking at Monthly. */}
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {PLANS.map(plan => {
            // Overlay founder prices on the Pro card when applicable.
            // Other cards (just Free today) keep the static PLANS values.
            const displayPrices = plan.id === 'pro'
              ? proPricing
              : { monthlyPrice: plan.monthlyPrice, annualPrice: plan.annualPrice, annualBilled: plan.annualBilled }
            const showFounderBadge = plan.id === 'pro' && !!user?.founderPricing
            const isPro = plan.id === 'pro'
            return (
            <div
              key={plan.id}
              className="rounded-xl bg-white p-6"
              // Pro card: 2px Sunset Gold border — the premium signal.
              // Free card: 2px RV Blue border — gives Free its own brand
              // identity (was a thin neutral border that read as "lesser").
              // Both at 2px so they're visually balanced; only the color
              // differs to signal "Pro is premium" vs "Free is brand-blue".
              style={{
                border: isPro ? '2px solid #F7A829' : '2px solid #1F6F8B',
              }}
            >
              <h2 className="font-medium text-gray-900 text-lg mb-0.5">{plan.name}</h2>
              <p className="text-xs text-gray-500 mb-4">{plan.description}</p>

              <div className="mb-6">
                <div className="text-3xl font-medium text-gray-900">
                  {displayPrices.monthlyPrice === 0 ? 'Free' : (
                    <>
                      ${annual ? displayPrices.annualPrice : displayPrices.monthlyPrice}
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
                {annual && displayPrices.annualBilled && (
                  <p className="text-sm text-gray-600 mt-1">${displayPrices.annualBilled} billed annually</p>
                )}
                {/* Lifetime-locked founder rate badge — only renders on the
                    Pro card for users whose server-side founderPricing flag
                    is true. Same teal accent as the "Save N%" toggle badge
                    so the visual language stays consistent. */}
                {showFounderBadge && (
                  <p className="text-xs text-[#0F766E] mt-2 font-medium">Lifetime founder rate</p>
                )}
              </div>

              {plan.ctaTo ? (
                // Free-plan CTA — teal-outline (btn-outline class matches
                // the spec: white bg, #1F6F8B text + border, hover #E0F0F4
                // subtle tint).
                <Link to={plan.ctaTo} className="block text-center py-2.5 rounded-lg text-sm font-medium mb-6 btn-outline">
                  {plan.cta}
                </Link>
              ) : (() => {
                // Per-render CTA — derived from current user state. The
                // literal `plan.cta` from PLANS is intentionally ignored for
                // paid plans (see comment on the PLANS entry).
                // Pro-plan CTA is solid Sunset Gold (#F7A829), white text,
                // hover darker gold (#C9851A from the existing palette —
                // the spec's #E89516 would have been a new hex). The
                // styling stays consistent whether the label reads
                // "Upgrade to Pro" or "Current plan" so the visual
                // hierarchy doesn't shift between states.
                const cta = getCta(plan.id, user)
                return (
                  <button
                    onClick={() => handleUpgrade(plan.id)}
                    disabled={loading === plan.id || cta.disabled}
                    className="w-full py-2.5 rounded-lg text-sm font-medium mb-6 transition-colors bg-[#F7A829] text-white hover:bg-[#C9851A] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {loading === plan.id ? 'Loading...' : cta.label}
                  </button>
                )
              })()}

              {/* Features can be a flat string array (Pro card) or a list of
                  {sectionLabel, items} sections (Free card). Branch at the
                  item level so both shapes render in one pass; the section
                  case emits a small label + nested bullets. */}
              <div className="space-y-2">
                {plan.features.map((feature, i) => {
                  if (typeof feature === 'string') {
                    return (
                      <div key={i} className="flex items-start gap-2 text-sm text-gray-600">
                        <Check size={14} className="text-[#1D9E75] flex-shrink-0 mt-0.5" />
                        <span>{feature}</span>
                      </div>
                    )
                  }
                  // Sectioned features (Free card). First section has no
                  // extra top margin; subsequent sections get mt-3 for visual
                  // separation between "Includes a 7-day Pro trial:" and
                  // "After trial:".
                  return (
                    <div key={i} className={i === 0 ? '' : 'mt-3'}>
                      <p className="text-xs font-medium text-[#5F5E5A] mb-1.5">{feature.sectionLabel}</p>
                      <div className="space-y-2">
                        {feature.items.map((item, j) => (
                          <div key={j} className="flex items-start gap-2 text-sm text-gray-600">
                            <Check size={14} className="text-[#1D9E75] flex-shrink-0 mt-0.5" />
                            <span>{item}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            )
          })}
        </div>

        <p className="text-center text-xs text-gray-400 mt-8">
          Start your 7-day free trial • Cancel anytime • Secure payment via Stripe
        </p>
      </div>
    </div>
  )
}
