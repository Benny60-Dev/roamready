import { useEffect, useState } from 'react'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { Wand2, Loader } from 'lucide-react'
import { adminApi, feedbackApi } from '../../services/api'
import { Feedback } from '../../types'

const STATUS_OPTIONS = ['NEW', 'PLANNED', 'IN_PROGRESS', 'SHIPPED', 'DECLINED']

export default function AdminFeedbackPage() {
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [analysis, setAnalysis] = useState('')
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [filter, setFilter] = useState('ALL')

  useEffect(() => {
    adminApi.getFeedback().then(res => { setFeedback(res.data); setLoading(false) })
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

  async function updateStatus(id: string, status: string) {
    await feedbackApi.updateStatus(id, status)
    setFeedback(prev => prev.map(f => f.id === id ? { ...f, status: status as any } : f))
  }

  const filtered = filter === 'ALL' ? feedback : feedback.filter(f => f.status === filter || f.type === filter)

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
        {['ALL', 'NEW', 'PLANNED', 'IN_PROGRESS', 'SHIPPED', 'FEATURE_REQUEST', 'BUG_REPORT'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-lg text-xs border transition-colors ${filter === f ? 'bg-[#1F6F8B] text-white border-[#1F6F8B]' : 'border-gray-200 text-gray-600'}`}
            style={{ borderWidth: '0.5px' }}>
            {f.replace('_', ' ')}
          </button>
        ))}
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
                  {item.user && <p className="text-xs text-gray-400 mt-0.5">{item.user.email}</p>}
                </div>
                <select
                  value={item.status}
                  onChange={e => updateStatus(item.id, e.target.value)}
                  className="text-xs border border-gray-200 rounded px-2 py-1 flex-shrink-0"
                  style={{ borderWidth: '0.5px' }}
                >
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
