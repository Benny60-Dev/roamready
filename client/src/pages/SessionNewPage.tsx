import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader } from 'lucide-react'
import { sessionsApi } from '../services/api'
import type { PlanningSession } from '../types'

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'a moment ago'
  if (diff < hour) {
    const m = Math.floor(diff / minute)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (diff < day) {
    const h = Math.floor(diff / hour)
    return `${h} hour${h === 1 ? '' : 's'} ago`
  }
  if (diff < 2 * day) return 'yesterday'
  if (diff < 7 * day) {
    const d = Math.floor(diff / day)
    return `${d} days ago`
  }
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function SessionNewPage() {
  const navigate = useNavigate()
  const [resumeCandidate, setResumeCandidate] = useState<PlanningSession | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setChecking(true)
    sessionsApi
      .getLatestActive()
      .then(latest => {
        if (cancelled) return
        if (latest) {
          setResumeCandidate(latest)
          setChecking(false)
        } else {
          // No latest — go straight to creating a fresh session
          createFresh()
        }
      })
      .catch(() => {
        if (cancelled) return
        // On lookup failure, fall back to creating a fresh session
        createFresh()
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function createFresh() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await sessionsApi.create({})
      navigate(`/sessions/${res.data.id}`, { replace: true })
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Could not start a new session.')
      setBusy(false)
      setChecking(false)
    }
  }

  function resume() {
    if (!resumeCandidate) return
    navigate(`/sessions/${resumeCandidate.id}`, { replace: true })
  }

  if (checking || (!resumeCandidate && !error)) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        <Loader size={20} className="animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto mt-12 text-center">
        <p className="text-sm text-red-600 mb-4">{error}</p>
        <button onClick={createFresh} className="btn-primary">
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto mt-12">
      <div
        className="bg-white rounded-xl px-5 py-5"
        style={{ border: '0.5px solid #E8E4DA' }}
      >
        <h2 className="text-base font-medium text-gray-900 mb-1">
          Resume your last planning session?
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          "{resumeCandidate!.title || 'Untitled session'}" from {relativeTime(resumeCandidate!.updatedAt)}.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            onClick={resume}
            disabled={busy}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-60"
            style={{ backgroundColor: '#1F6F8B' }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#134756' }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#1F6F8B' }}
          >
            Resume
          </button>
          <button
            onClick={createFresh}
            disabled={busy}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
            style={{
              backgroundColor: 'transparent',
              border: '0.5px solid #1F6F8B',
              color: '#1F6F8B',
            }}
          >
            {busy ? 'Starting…' : 'Start fresh'}
          </button>
        </div>
      </div>
    </div>
  )
}
