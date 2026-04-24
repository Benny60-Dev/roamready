import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ThumbsUp, MessageSquare } from 'lucide-react'
import { feedbackApi } from '../services/api'
import { Feedback } from '../types'
import { useUIStore } from '../store/uiStore'
import { useAuthStore } from '../store/authStore'

function FeedbackCard({ item, onVote }: { item: Feedback; onVote: (id: string) => void }) {
  const { isAuthenticated } = useAuthStore()
  const typeColors: Record<string, string> = {
    FEATURE_REQUEST: 'badge-blue',
    BUG_REPORT: 'badge-red',
    GENERAL: 'bg-gray-100 text-gray-600',
    CAMPGROUND_REVIEW: 'badge-green',
  }
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <span className={`badge text-xs mb-2 ${typeColors[item.type] || 'bg-gray-100 text-gray-600'}`}>
            {item.type.replace('_', ' ').toLowerCase()}
          </span>
          <p className="text-sm font-medium text-gray-900">{item.title || item.body.slice(0, 60)}</p>
          {item.title && <p className="text-xs text-gray-500 mt-0.5">{item.body.slice(0, 80)}{item.body.length > 80 ? '...' : ''}</p>}
        </div>
        <button
          onClick={() => isAuthenticated() && onVote(item.id)}
          className="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg border border-gray-200 hover:border-[#1E3A8A] hover:text-[#1E3A8A] transition-colors text-gray-400"
          style={{ borderWidth: '0.5px' }}
        >
          <ThumbsUp size={13} />
          <span className="text-xs">{item.votes}</span>
        </button>
      </div>
    </div>
  )
}

export default function RoadmapPage() {
  const [data, setData] = useState<{ planned: Feedback[]; inProgress: Feedback[]; shipped: Feedback[] }>({
    planned: [], inProgress: [], shipped: []
  })
  const [loading, setLoading] = useState(true)
  const { openFeedbackModal } = useUIStore()

  useEffect(() => {
    feedbackApi.getPublic().then(res => { setData(res.data); setLoading(false) })
  }, [])

  async function vote(id: string) {
    await feedbackApi.vote(id)
    feedbackApi.getPublic().then(res => setData(res.data))
  }

  const Column = ({ title, items, color }: { title: string; items: Feedback[]; color: string }) => (
    <div>
      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium mb-3 ${color}`}>
        {title} <span className="opacity-70">({items.length})</span>
      </div>
      <div className="space-y-2">
        {items.map(item => <FeedbackCard key={item.id} item={item} onVote={vote} />)}
        {items.length === 0 && <p className="text-xs text-gray-400 italic">Nothing here yet</p>}
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-rr-bg">
      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="flex items-center justify-between mb-8">
          <div>
            <Link to="/" className="text-sm text-gray-500 hover:text-gray-700 mb-2 inline-block">← RoamReady</Link>
            <h1 className="text-2xl font-medium text-gray-900">Product Roadmap</h1>
            <p className="text-sm text-gray-500 mt-1">See what we're working on and vote on what matters to you.</p>
          </div>
          <button onClick={openFeedbackModal} className="btn-primary flex items-center gap-1.5">
            <MessageSquare size={15} /> Submit feedback
          </button>
        </div>

        {loading ? (
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map(i => <div key={i} className="space-y-2">{[1, 2, 3].map(j => <div key={j} className="card h-20 animate-pulse bg-gray-50" />)}</div>)}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Column title="Planned" items={data.planned} color="bg-blue-50 text-blue-700" />
            <Column title="In Progress" items={data.inProgress} color="bg-amber-50 text-amber-700" />
            <Column title="Shipped" items={data.shipped} color="bg-[#CCFBF1] text-[#0D5F58]" />
          </div>
        )}
      </div>
    </div>
  )
}
