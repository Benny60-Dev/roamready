import { useEffect, useRef, useState } from 'react'
import { sessionsApi, UpdateSessionPayload } from '../services/api'
import { useAuthStore } from '../store/authStore'

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'error'

const DEBOUNCE_MS = 1500

/**
 * Persists a planning session to the server 1.5s after the latest change.
 * Best-effort flush on tab close via fetch keepalive (works with Bearer auth).
 *
 * No-op when sessionId is null/undefined — useful while a fresh /sessions/new
 * page is still creating its session row.
 */
export function useSessionAutosave(
  sessionId: string | null | undefined,
  data: UpdateSessionPayload
) {
  const [state, setState] = useState<AutosaveState>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef<UpdateSessionPayload>(data)
  const sessionIdRef = useRef<string | null | undefined>(sessionId)
  const firstRunRef = useRef(true)

  latestRef.current = data
  sessionIdRef.current = sessionId

  useEffect(() => {
    if (!sessionId) return
    if (firstRunRef.current) {
      firstRunRef.current = false
      return
    }

    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      setState('saving')
      try {
        await sessionsApi.update(sessionId, latestRef.current)
        setState('saved')
      } catch {
        setState('error')
      }
    }, DEBOUNCE_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [sessionId, JSON.stringify(data)])

  // Best-effort flush on tab close. Bearer-auth requires a header, so navigator.sendBeacon
  // (which can't set Authorization) won't work — use fetch with keepalive instead.
  useEffect(() => {
    function handleBeforeUnload() {
      const id = sessionIdRef.current
      if (!id) return
      const token = useAuthStore.getState().token
      try {
        fetch(`/api/v1/sessions/${id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: 'include',
          body: JSON.stringify(latestRef.current),
          keepalive: true,
        })
      } catch {
        /* fire-and-forget */
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  return state
}
