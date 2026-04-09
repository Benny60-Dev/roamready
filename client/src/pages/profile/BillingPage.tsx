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

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Billing</h1>

      {/* Current plan */}
      <div className={`card-lg ${isTrialing ? 'border-[#1D9E75]/30 bg-[#E1F5EE]/30' : ''}`}>
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <p className="font-medium text-gray-900">{user?.subscriptionTier === 'FREE' ? 'Free' : user?.subscriptionTier === 'PRO' ? 'Pro' : 'Pro+'} Plan</p>
              {isTrialing && <span className="badge-green text-xs">Trial active</span>}
            </div>
            {isTrialing ? (
              <p className="text-sm text-gray-500">Trial ends in {trialDaysLeft} day{trialDaysLeft !== 1 ? 's' : ''} — upgrade to keep Pro features</p>
            ) : user?.subscriptionEndsAt ? (
              <p className="text-sm text-gray-500">Renews {format(new Date(user.subscriptionEndsAt), 'MMM d, yyyy')}</p>
            ) : (
              <p className="text-sm text-gray-500">Free plan</p>
            )}
          </div>
          <div className="flex gap-2">
            {user?.subscriptionTier !== 'FREE' && (
              <button onClick={openPortal} disabled={portalLoading} className="btn-outline text-sm flex items-center gap-1.5">
                <ExternalLink size={13} /> Manage
              </button>
            )}
            <Link to="/profile/billing/upgrade" className="btn-primary text-sm">
              {user?.subscriptionTier === 'FREE' ? 'Upgrade' : 'Change plan'}
            </Link>
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
                    <a href={inv.pdf} target="_blank" rel="noreferrer" className="text-[#1D9E75] text-xs flex items-center gap-1">
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
