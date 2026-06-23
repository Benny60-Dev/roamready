import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { subscriptionsApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { format } from 'date-fns'

export default function BillingPage() {
  const { user } = useAuthStore()
  const [invoices, setInvoices] = useState<any[]>([])
  const [portalLoading, setPortalLoading] = useState(false)

  useEffect(() => {
    subscriptionsApi.getInvoices().then(res => setInvoices(res.data))
  }, [])

  async function openPortal() {
    setPortalLoading(true)
    try {
      const res = await subscriptionsApi.createPortal()
      if (res.data.url) window.location.href = res.data.url
    } finally {
      setPortalLoading(false)
    }
  }

  const isTrialing = user?.trialEndsAt && new Date() < new Date(user.trialEndsAt)
  const trialDaysLeft = user?.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(user.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0

  // A real (paying) Stripe subscription. subscriptionTier flips to PRO on
  // checkout and is the source of truth for "paying customer".
  const hasRealSub = user?.subscriptionTier !== 'FREE'

  // Complimentary (owner-granted) Pro. Only shown when there is NO real sub —
  // a paying subscription always takes display precedence. Valid = compTier PRO
  // and either lifetime (no expiry) or not yet expired. Mirrors hasAccess().
  const compActive =
    !hasRealSub &&
    user?.compTier === 'PRO' &&
    (!user?.compExpiresAt || new Date() < new Date(user.compExpiresAt))
  const compLifetime = compActive && !user?.compExpiresAt
  const compExpiresLabel = user?.compExpiresAt
    ? format(new Date(user.compExpiresAt), 'MMM d, yyyy')
    : null

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Billing</h1>

      {/* Current plan. Display precedence: real Stripe sub → complimentary Pro →
          free/trial. compActive intentionally suppresses the trial/Free/Upgrade
          messaging, which is false for a comped user. */}
      <div className={`card-lg ${compActive ? 'border-indigo-200 bg-indigo-50/40' : isTrialing ? 'border-[#1F6F8B]/30 bg-[#E0F0F4]/30' : ''}`}>
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <p className="font-medium text-gray-900">
                {compActive ? 'Pro (complimentary)' : hasRealSub ? 'Pro' : 'Free'} Plan
              </p>
              {compActive && <span className="badge text-xs bg-indigo-100 text-indigo-700">Complimentary</span>}
              {isTrialing && !compActive && <span className="badge-green text-xs">Trial active</span>}
            </div>
            {/* Subtext branches on compActive first, then subscriptionTier BEFORE
                subscriptionEndsAt so a freshly-paid Pro user (whose
                subscriptionEndsAt is briefly null between
                checkout.session.completed and customer.subscription.updated
                webhooks) doesn't incorrectly read as "Free plan". The race
                window is also narrowed server-side (the checkout handler writes
                subscriptionEndsAt eagerly); this UI guard remains as
                defense-in-depth in case a webhook delivery fails entirely. */}
            {compActive ? (
              <p className="text-sm text-gray-500">
                {compLifetime
                  ? 'Complimentary Pro access — Lifetime'
                  : `Complimentary Pro access — expires ${compExpiresLabel}`}
              </p>
            ) : isTrialing ? (
              <p className="text-sm text-gray-500">Trial ends in {trialDaysLeft} day{trialDaysLeft !== 1 ? 's' : ''} — upgrade to keep Pro features</p>
            ) : !hasRealSub ? (
              <p className="text-sm text-gray-500">No active subscription</p>
            ) : user?.subscriptionEndsAt ? (
              <p className="text-sm text-gray-500">Renews {format(new Date(user.subscriptionEndsAt), 'MMM d, yyyy')}</p>
            ) : (
              <p className="text-sm text-gray-500">Active subscription</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            {hasRealSub && (
              <button onClick={openPortal} disabled={portalLoading} className="btn-outline text-sm flex items-center gap-1.5">
                <ExternalLink size={13} /> Manage account
              </button>
            )}
            {/* Big primary "Upgrade" only for genuine Free users — never for a
                comped user (subscriptionTier is FREE for comps, but the upsell
                is false there). */}
            {!hasRealSub && !compActive && (
              <Link to="/profile/billing/upgrade" className="btn-primary text-sm">
                Upgrade
              </Link>
            )}
            {/* Time-limited comp: a soft, non-nagging prompt to subscribe before
                the comp lapses (reuses the normal checkout flow). Lifetime comps
                get no prompt at all. */}
            {compActive && !compLifetime && (
              <Link to="/profile/billing/upgrade" className="text-sm text-[#1F6F8B] hover:underline">
                Subscribe to keep Pro after {compExpiresLabel}
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Invoices */}
      {invoices.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-700 mb-2">Billing history</h2>
          <div className="card divide-y divide-gray-50">
            {invoices.map(inv => (
              <div key={inv.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm text-gray-900">{format(new Date(inv.date), 'MMMM d, yyyy')}</p>
                  <p className="text-xs text-gray-500 capitalize">{inv.status}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-900">
                    ${(inv.amount / 100).toFixed(2)} {inv.currency.toUpperCase()}
                  </span>
                  {inv.pdf && (
                    <a href={inv.pdf} target="_blank" rel="noreferrer" className="text-[#1F6F8B] text-xs flex items-center gap-1">
                      <ExternalLink size={12} /> PDF
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
