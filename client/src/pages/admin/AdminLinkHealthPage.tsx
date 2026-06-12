import { useEffect, useState } from 'react'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react'
import { adminApi } from '../../services/api'

// The `dead` array stores ALL non-OK results (DEAD + REVIEW), each tagged with
// `state` by the checker. Older rows predate three-state and have no `state` —
// treat those as DEAD (the only thing the binary checker ever stored).
type LinkState = 'OK' | 'DEAD' | 'REVIEW'
interface ProblemLink { label: string; url: string; status: number | string; state?: LinkState; finalUrl?: string }
interface LinkHealthResult {
  checkedAt: string
  total: number
  okCount: number
  deadCount: number
  dead: ProblemLink[]
  driftWarning?: string | null
}

// Owner-only view of the latest monthly OHV link-check result (server writes it
// from the /internal/cron/ohv-link-check job). Read-only; null when no run yet.
export default function AdminLinkHealthPage() {
  const [result, setResult] = useState<LinkHealthResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminApi.getLinkHealth()
      .then(res => { setResult(res.data ?? null); setLoading(false) })
      .catch(() => { setResult(null); setLoading(false) })
  }, [])

  return (
    <div className="space-y-6 max-w-3xl">
      <Breadcrumb items={[{ label: 'Admin Dashboard' }, { label: 'Link Health' }]} />
      <h1 className="text-xl font-medium text-gray-900">OHV Link Health</h1>

      {loading ? (
        <div className="card h-24 animate-pulse bg-gray-50" />
      ) : !result ? (
        <div className="card text-center py-12">
          <p className="text-gray-700 text-sm font-medium mb-1">No link check has run yet.</p>
          <p className="text-gray-500 text-sm">The monthly checker writes results here once it runs.</p>
        </div>
      ) : (() => {
        // Split the tagged problem list into DEAD vs REVIEW. Old rows have no
        // `state` → DEAD (back-compat with the pre-three-state binary checker).
        const problems = result.dead ?? []
        const deadItems = problems.filter(d => (d.state ?? 'DEAD') === 'DEAD')
        const reviewItems = problems.filter(d => d.state === 'REVIEW')
        const allHealthy = deadItems.length === 0 && reviewItems.length === 0
        return (
        <div className="space-y-4">
          <div className="card flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">Last checked</p>
              <p className="text-sm font-medium text-gray-900">{new Date(result.checkedAt).toLocaleString()}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500">Healthy</p>
              <p className={`text-lg font-medium ${allHealthy ? 'text-emerald-600' : 'text-amber-600'}`}>
                {result.okCount} of {result.total}
              </p>
            </div>
          </div>

          {result.driftWarning && (
            <div className="card border border-amber-200 bg-amber-50/40 flex items-start gap-2">
              <AlertTriangle size={16} className="text-amber-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <p className="text-xs text-amber-700">{result.driftWarning}</p>
            </div>
          )}

          {allHealthy && (
            <div className="card flex items-center gap-2 text-emerald-700">
              <CheckCircle2 size={18} className="flex-shrink-0" aria-hidden="true" />
              <p className="text-sm font-medium">All {result.total} links healthy.</p>
            </div>
          )}

          {deadItems.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-gray-700 mb-2">
                {deadItems.length} dead link{deadItems.length === 1 ? '' : 's'} — fix these
              </h2>
              <div className="space-y-2">
                {deadItems.map((d, i) => (
                  <div key={i} className="card flex items-start gap-3">
                    <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{d.label}</p>
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-[#1F6F8B] inline-flex items-center gap-1 break-all"
                      >
                        {d.url} <ExternalLink size={11} className="flex-shrink-0" aria-hidden="true" />
                      </a>
                      {d.finalUrl && (
                        <p className="text-[11px] text-gray-500 break-all">→ redirected to {d.finalUrl}</p>
                      )}
                    </div>
                    <span className="badge bg-red-50 text-red-700 text-xs flex-shrink-0">{d.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {reviewItems.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-gray-700 mb-1">
                {reviewItems.length} need{reviewItems.length === 1 ? 's' : ''} manual review
              </h2>
              <p className="text-xs text-gray-500 mb-2">Could not confirm from an automated check — not necessarily dead. Open each in a browser.</p>
              <div className="space-y-2">
                {reviewItems.map((d, i) => (
                  <div key={i} className="card flex items-start gap-3">
                    <AlertTriangle size={16} className="text-amber-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{d.label}</p>
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-[#1F6F8B] inline-flex items-center gap-1 break-all"
                      >
                        {d.url} <ExternalLink size={11} className="flex-shrink-0" aria-hidden="true" />
                      </a>
                      {d.finalUrl && (
                        <p className="text-[11px] text-gray-500 break-all">→ redirected to {d.finalUrl}</p>
                      )}
                    </div>
                    <span className="badge bg-amber-50 text-amber-700 text-xs flex-shrink-0">{d.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        )
      })()}
    </div>
  )
}
