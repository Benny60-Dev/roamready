import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader } from 'lucide-react'
import { sessionsApi } from '../services/api'

export default function SessionNewPage() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    sessionsApi
      .getLatestActive()
      .then(latest => {
        if (cancelled) return
        if (latest) {
          // Silent-resume fast-paths for IN-APP navigation (kept intact):
          //
          // A — sessionStorage flag (explicit signal). SessionPage writes
          //   `lastVisitedSessionId` on mount. If the user just came back from
          //   /profile or another internal route, this id matches and we
          //   silently route them back into that session.
          //
          // B — recent updatedAt window (fallback). Within 5 minutes of the
          //   last autosave we treat the visit as in-session navigation even
          //   if the sessionStorage flag is missing (private window that nuked
          //   storage, or a new tab that lost the flag).
          const lastVisited = sessionStorage.getItem('lastVisitedSessionId')
          if (lastVisited === latest.id) {
            navigate(`/sessions/${latest.id}`, { replace: true })
            return
          }
          const updatedAt = new Date(latest.updatedAt).getTime()
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
          if (updatedAt > fiveMinutesAgo) {
            navigate(`/sessions/${latest.id}`, { replace: true })
            return
          }
          // STALE case (both fast-paths failed — a "returning later" Home
          // click): Home IS the planning canvas, so we do NOT show a
          // Resume/Start-fresh modal. Start a fresh canvas, same as a brand-new
          // start. The prior session is NOT lost or deleted — createFresh only
          // inserts a new row; the stale session remains in the header "Your
          // planning sessions" panel (SessionsPanel, AppLayout) one click away.
          createFresh()
        } else {
          // No latest active session — go straight to a fresh canvas.
          createFresh()
        }
      })
      .catch(() => {
        if (cancelled) return
        // On lookup failure, fall back to creating a fresh session.
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
    }
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

  // Home is the planning canvas: every resolved path above navigates away
  // (silent resume or fresh create), so this component only renders a loader
  // until that navigation happens — or the error block above on create failure.
  // The Resume/Start-fresh modal was removed (it surfaced on every stale-session
  // Home click after the nav repoint made /sessions/new the Home target).
  return (
    <div className="flex items-center justify-center py-20 text-gray-400">
      <Loader size={20} className="animate-spin" />
    </div>
  )
}
