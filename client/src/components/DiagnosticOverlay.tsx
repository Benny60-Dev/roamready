// TEMP DIAGNOSTIC - REMOVE
// ─────────────────────────────────────────────────────────────────────────────
// Temporary on-screen overlay to instrument the conversation-view top-clip.
// Measurement ONLY — it does not change any layout or scroll behavior.
//
// Surfaces:
//   build       — bundle marker; bump to confirm a fresh load (currently v4)
//   scrollY     — window.scrollY (live, sampled)
//   scrollH     — document.documentElement.scrollHeight
//   innerH      — window.innerHeight
//   vvH/vvTop   — visualViewport height / offsetTop
//   t           — ms since this component mounted
//   edgeRuns    — times SessionPage's prevEmptyRef edge effect body ran
//   justActiv.  — times the empty->active (blur+scrollTo) branch was entered
//   scrollEvts  — count of window 'scroll' events fired (did something actively
//                 scroll, or did scrollY change with NO event?)
//   lastScrollY — scrollY captured at the last 'scroll' event
//   tAt84       — value of `t` the moment scrollY FIRST became > 0 after mount
//                 (i.e. when the 84 lands in the lifecycle)
//
// To remove: delete this file, diagnosticsBus.ts, the two `diag.*++` lines in
// SessionPage, and the <DiagnosticOverlay/> usage in AppLayout (grep
// "TEMP DIAGNOSTIC").
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react'
import { diag } from './diagnosticsBus'

const BUILD = 'v4'

export default function DiagnosticOverlay() {
  const [, force] = useState(0)
  const [mountedAt] = useState(() => performance.now())

  const scrollEventsRef = useRef(0)
  const lastScrollYRef = useRef(0)
  const firstNonZeroTRef = useRef<number | null>(null)

  useEffect(() => {
    // Record when scrollY first becomes > 0 (the moment the clip lands).
    const noteFirstNonZero = () => {
      if (firstNonZeroTRef.current === null && window.scrollY > 0) {
        firstNonZeroTRef.current = Math.round(performance.now() - mountedAt)
      }
    }
    // Window 'scroll' event — counts as an ACTIVE scroll. If scrollY reaches 84
    // but this stays 0, the value was set without a scroll event (layout/focus).
    const onScroll = () => {
      scrollEventsRef.current += 1
      lastScrollYRef.current = Math.round(window.scrollY)
      noteFirstNonZero()
      force(n => n + 1)
    }
    // Non-scroll triggers: just re-sample + check the first-nonzero edge.
    const onSample = () => {
      noteFirstNonZero()
      force(n => n + 1)
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onSample)
    const vv = window.visualViewport
    vv?.addEventListener('resize', onSample)
    vv?.addEventListener('scroll', onSample)
    const interval = window.setInterval(onSample, 250)

    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onSample)
      vv?.removeEventListener('resize', onSample)
      vv?.removeEventListener('scroll', onSample)
      window.clearInterval(interval)
    }
  }, [mountedAt])

  const vv = typeof window !== 'undefined' ? window.visualViewport : undefined
  const rows: Array<[string, number | string | undefined]> = [
    ['build', BUILD],
    ['scrollY', Math.round(window.scrollY)],
    ['scrollH', document.documentElement.scrollHeight],
    ['innerH', window.innerHeight],
    ['vvH', vv ? Math.round(vv.height) : undefined],
    ['vvTop', vv ? Math.round(vv.offsetTop) : undefined],
    ['t', Math.round(performance.now() - mountedAt)],
    ['edgeRuns', diag.edgeRuns],
    ['justActiv', diag.justActivated],
    ['scrollEvts', scrollEventsRef.current],
    ['lastScrollY', lastScrollYRef.current],
    ['tAt84', firstNonZeroTRef.current ?? '-'],
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
