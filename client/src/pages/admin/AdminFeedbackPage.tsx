import { useEffect, useState } from 'react'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { Wand2, Loader } from 'lucide-react'
import { adminApi } from '../../services/api'
import { Feedback } from '../../types'
import { fbRef } from '../../utils/fbRef'
import { lifecycleDate } from '../../utils/dates'

const STATUS_OPTIONS = ['NEW', 'PLANNED', 'IN_PROGRESS', 'SHIPPED', 'DECLINED']

// Gmail search deep-link base. /u/0/ = the browser's first signed-in account —
// bump the index (or swap the host) if the support inbox lives elsewhere.
const GMAIL_SEARCH_URL = 'https://mail.google.com/mail/u/0/#search/'

// Working-view tabs. Active is the default inbox (everything still in
// flight); Shipped/Declined are the terminal statuses awaiting archive;
// Archived holds what's been swept out of the way; All shows everything.
type FeedbackTab = 'ACTIVE' | 'SHIPPED' | 'DECLINED' | 'ARCHIVED' | 'ALL'
const TABS: { key: FeedbackTab; label: string }[] = [
  { key: 'ACTIVE', label: 'Active' },
  { key: 'SHIPPED', label: 'Shipped' },
  { key: 'DECLINED', label: 'Declined' },
  { key: 'ARCHIVED', label: 'Archived' },
  { key: 'ALL', label: 'All' },
]

function inTab(f: Feedback, tab: FeedbackTab): boolean {
  const archived = f.archivedAt != null
  switch (tab) {
    case 'ACTIVE': return !archived && (f.status === 'NEW' || f.status === 'PLANNED' || f.status === 'IN_PROGRESS')
    case 'SHIPPED': return !archived && f.status === 'SHIPPED'
    case 'DECLINED': return !archived && f.status === 'DECLINED'
    case 'ARCHIVED': return archived
    case 'ALL': return true
  }
}

export default function AdminFeedbackPage() {
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [analysis, setAnalysis] = useState('')
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [tab, setTab] = useState<FeedbackTab>('ACTIVE')

  useEffect(() => {
    // Fetch everything (archived included) once — the tabs and their count
    // badges filter client-side, so switching tabs costs no round-trips.
    adminApi.getFeedback({ includeArchived: true }).then(res => { setFeedback(res.data); setLoading(false) })
  }, [])

  async function analyze() {
    setAnalyzing(true)
    try {
      const res = await adminApi.analyzeFeedback()
      setAnalysis(res.data.analysis)
    } finally {
      setAnalyzing(false)
    }
  }

  async function updateItem(id: string, patch: { status?: string; isPublic?: boolean; archived?: boolean }) {
    await adminApi.updateFeedback(id, patch)
    // Optimistic local merge — `archived` is a wire boolean that maps to the
    // archivedAt timestamp the tabs filter on.
    const { archived, ...rest } = patch
    const localPatch = {
      ...rest,
      ...(archived !== undefined ? { archivedAt: archived ? new Date().toISOString() : null } : {}),
    }
    setFeedback(prev => prev.map(f => f.id === id ? { ...f, ...localPatch } as Feedback : f))
  }

  const filtered = feedback
    .filter(f => inTab(f, tab))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return (
    <div className="space-y-4 max-w-4xl">
      <Breadcrumb items={[
        { label: 'Admin', href: '/admin' },
        { label: 'Feedback' },
      ]} />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-gray-900">Feedback Inbox</h1>
        <button onClick={analyze} disabled={analyzing} className="btn-primary flex items-center gap-1.5 text-sm">
          {analyzing ? <Loader size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {analyzing ? 'Analyzing...' : 'AI Analysis'}
        </button>
      </div>

      {analysis && (
        <div className="card-lg bg-[#E0F0F4]/30 border-[#1F6F8B]/30">
          <h3 className="font-medium text-gray-900 mb-3">AI Analysis</h3>
          <pre className="text-xs text-gray-700 whitespace-pre-wrap font-sans">{analysis}</pre>
        </div>
      )}

      <div className="flex gap-1 flex-wrap">
        {TABS.map(({ key, label }) => {
          const count = feedback.filter(f => inTab(f, key)).length
          return (
            <button key={key} onClick={() => setTab(key)}
              className={`px-3 py-1 rounded-lg text-xs border transition-colors flex items-center gap-1.5 ${tab === key ? 'bg-[#1F6F8B] text-white border-[#1F6F8B]' : 'border-gray-200 text-gray-600'}`}
              style={{ borderWidth: '0.5px' }}>
              {label}
              <span className={`px-1 rounded ${tab === key ? 'bg-white/20' : 'bg-gray-100 text-gray-500'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="card h-16 animate-pulse bg-gray-50" />)}</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(item => (
            <div key={item.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="badge bg-gray-100 text-gray-600 text-xs">{item.type.replace('_', ' ')}</span>
                    {item.votes > 0 && <span className="text-xs text-[#1F6F8B]">👍 {item.votes}</span>}
                  </div>
                  <p className="text-sm font-medium text-gray-900">{item.title || item.body.slice(0, 60)}</p>
                  {item.title && <p className="text-xs text-gray-500 mt-0.5">{item.body}</p>}
                  {item.user && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      {[item.user.firstName, item.user.lastName].filter(Boolean).join(' ') || 'No name'}
                      {' · '}{item.user.email}{' · '}
                      {/* Primary: land in Gmail on a search for this item's ref —
                          every email about it in one view, reply in-thread. */}
                      <a
                        href={`${GMAIL_SEARCH_URL}${encodeURIComponent(fbRef(item.id))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#1F6F8B] hover:underline"
                      >
                        Find in Gmail
                      </a>
                      {' · '}
                      {/* Secondary: fresh pre-addressed compose (mailto) for items
                          with no existing email to reply to. The [FB-xxxx] ref in
                          the subject keys future threading + the Gmail search. */}
                      <a
                        href={`mailto:${item.user.email}?subject=${encodeURIComponent(
                          `Re: [${fbRef(item.id)}] ${item.title || item.type.replace('_', ' ')}`
                        )}`}
                        className="text-[#1F6F8B] hover:underline"
                      >
                        Reply
                      </a>
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  <select
                    value={item.status}
                    onChange={e => updateItem(item.id, { status: e.target.value })}
                    className="text-xs border border-gray-200 rounded px-2 py-1"
                    style={{ borderWidth: '0.5px' }}
                  >
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={item.isPublic}
                      onChange={e => updateItem(item.id, { isPublic: e.target.checked })}
                      className="rounded"
                    />
                    Public
                  </label>
                  {/* Shipped-notice receipt — server stamps this only after the
                      "your request shipped" email actually sent. Display-only;
                      the notification itself is automatic on the status change. */}
                  {item.status === 'SHIPPED' && item.shippedNotifiedAt && (
                    <span className="text-xs text-[#0F766E]">
                      ✓ Notified {lifecycleDate(item.shippedNotifiedAt)}
                    </span>
                  )}
                  {/* Archive only offered once an item is terminal (SHIPPED /
                      DECLINED); archived items get Unarchive instead. */}
                  {item.archivedAt != null ? (
                    <button
                      onClick={() => updateItem(item.id, { archived: false })}
                      className="text-xs text-[#1F6F8B] hover:underline"
                    >
                      Unarchive
                    </button>
                  ) : (item.status === 'SHIPPED' || item.status === 'DECLINED') && (
                    <button
                      onClick={() => updateItem(item.id, { archived: true })}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Archive
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
