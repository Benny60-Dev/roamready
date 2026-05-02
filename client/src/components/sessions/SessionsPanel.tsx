import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { X } from 'lucide-react'
import { sessionsApi } from '../../services/api'
import type { PlanningSession } from '../../types'

interface Props {
  open: boolean
  onClose: () => void
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return 'Just now'
  if (diff < hour) {
    const m = Math.floor(diff / minute)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (diff < day) {
    const h = Math.floor(diff / hour)
    return `${h} hour${h === 1 ? '' : 's'} ago`
  }
  if (diff < 2 * day) return 'Yesterday'
  if (diff < 7 * day) {
    const d = Math.floor(diff / day)
    return `${d} days ago`
  }
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function StatusPill({ status }: { status: PlanningSession['status'] }) {
  if (status === 'COMPLETED') {
    return (
      <span
        className="inline-flex items-center"
        style={{
          backgroundColor: '#DCE5D5',
          color: '#2F4030',
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 999,
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        Completed
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center"
      style={{
        backgroundColor: '#FDEFD9',
        color: '#8A5A0E',
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        fontWeight: 500,
        flexShrink: 0,
      }}
    >
      Planning
    </span>
  )
}

export default function SessionsPanel({ open, onClose }: Props) {
  const navigate = useNavigate()
  const { id: activeId } = useParams<{ id: string }>()
  const [sessions, setSessions] = useState<PlanningSession[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    sessionsApi
      .list()
      .then(res => {
        if (!cancelled) setSessions(res.data)
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Esc to close
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  function openSession(id: string) {
    navigate(`/sessions/${id}`)
    onClose()
  }

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40"
          style={{ backgroundColor: '#00000050' }}
          onClick={onClose}
          aria-hidden
        />
      )}

      {/* Panel */}
      <aside
        aria-hidden={!open}
        className="fixed top-0 left-0 h-full bg-white z-50 flex flex-col transition-transform duration-200 ease-out"
        style={{
          width: 'min(100vw, 280px)',
          borderRight: '0.5px solid #E8E4DA',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '0.5px solid #E8E4DA' }}
        >
          <h2 style={{ fontSize: 15, fontWeight: 500, color: '#1a1a1a' }}>
            Your planning sessions
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="px-3 py-3 space-y-2">
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="rounded-lg animate-pulse"
                  style={{ backgroundColor: '#EDEAE3', height: 56 }}
                />
              ))}
            </div>
          )}

          {!loading && sessions && sessions.length === 0 && (
            <div className="px-6 py-12 text-center text-sm" style={{ color: '#888780' }}>
              No planning sessions yet — start one with "Plan a trip".
            </div>
          )}

          {!loading && sessions && sessions.length > 0 && (
            <ul className="py-1">
              {sessions.map(s => {
                const isActive = s.id === activeId
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => openSession(s.id)}
                      className="w-full text-left px-4 py-3 transition-colors"
                      style={{
                        backgroundColor: isActive ? '#F5F4F2' : 'transparent',
                      }}
                      onMouseEnter={e => {
                        if (!isActive) e.currentTarget.style.backgroundColor = '#F5F4F2'
                      }}
                      onMouseLeave={e => {
                        if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div
                            className="truncate"
                            style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a' }}
                          >
                            {s.title || 'Untitled session'}
                          </div>
                          <div style={{ fontSize: 12, color: '#888780', marginTop: 2 }}>
                            {relativeTime(s.updatedAt)}
                          </div>
                        </div>
                        <StatusPill status={s.status} />
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>
    </>
  )
}
