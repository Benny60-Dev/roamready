// TEMP DIAGNOSTIC - REMOVE
// ─────────────────────────────────────────────────────────────────────────────
// Temporary on-screen overlay to measure the RESIDUAL top-clipping after the
// 100dvh app-shell fix (commit 02105f3). Measurement ONLY — it does not change
// any layout or scroll behavior. Live-displays window/viewport scroll metrics
// and a since-mount millisecond counter so we can watch whether scrollY drifts
// upward in the second after load (scroll-anchoring) vs lands once (early reset).
//
// To remove: delete this file and its <DiagnosticOverlay /> usage in
// components/layout/AppLayout.tsx (grep "TEMP DIAGNOSTIC").
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react'

export default function DiagnosticOverlay() {
  const [, force] = useState(0)
  const [mountedAt] = useState(() => performance.now())

  useEffect(() => {
    const update = () => force(n => n + 1)

    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    const vv = window.visualViewport
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    const interval = window.setInterval(update, 250)

    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.clearInterval(interval)
    }
  }, [])

  const vv = typeof window !== 'undefined' ? window.visualViewport : undefined
  const rows: Array<[string, number | string | undefined]> = [
    ['scrollY', Math.round(window.scrollY)],
    ['scrollH', document.documentElement.scrollHeight],
    ['innerH', window.innerHeight],
    ['vvH', vv ? Math.round(vv.height) : undefined],
    ['vvTop', vv ? Math.round(vv.offsetTop) : undefined],
    ['t', Math.round(performance.now() - mountedAt)],
  ]

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 2147483647, // max — sits above the clipped header
        pointerEvents: 'none',
        fontFamily: 'monospace',
        fontSize: '10px',
        lineHeight: '13px',
        padding: '4px 6px',
        background: 'rgba(0, 0, 0, 0.78)',
        color: '#0f0',
        whiteSpace: 'pre',
        borderBottomRightRadius: '4px',
      }}
    >
      {rows.map(([label, value]) => `${label}: ${value ?? 'n/a'}`).join('\n')}
    </div>
  )
}
