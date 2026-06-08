// TEMP DIAGNOSTIC - REMOVE
// ─────────────────────────────────────────────────────────────────────────────
// Temporary on-screen overlay to instrument the conversation-view top-clip.
// Measurement ONLY — it does not change any layout or scroll behavior (it wraps
// window.scrollTo / Element.scrollIntoView to COUNT + trace calls, then forwards
// to the originals unchanged, and restores them on unmount).
//
// Surfaces:
//   build       — bundle marker; bump to confirm a fresh load (currently v5)
//   scrollY     — window.scrollY (live, sampled)
//   scrollH     — document.documentElement.scrollHeight
//   innerH      — window.innerHeight
//   vvH/vvTop   — visualViewport height / offsetTop
//   t           — ms since this component mounted
//   edgeRuns    — times SessionPage's prevEmptyRef edge effect body ran
//   justActiv.  — times the empty->active (blur+scrollTo) branch was entered
//   listScrolls — times the committed message-list auto-scroll effect scrolled
//   listKind    — what that effect did (listRef.scrollTop vs other)
//   winScrollTo — count of window.scrollTo(...) calls (any caller)
//   intoView    — count of Element.scrollIntoView(...) calls (any caller)
//   lastSrc     — top non-wrapper stack frame of the last scrollTo/intoView call
//   scrollEvts  — count of window 'scroll' events fired
//   lastScrollY — scrollY captured at the last 'scroll' event
//   tAt84       — value of `t` the moment scrollY FIRST became > 0 after mount
//
// To remove: delete this file, diagnosticsBus.ts, the `diag.*` lines in
// SessionPage, and the <DiagnosticOverlay/> usage in AppLayout (grep
// "TEMP DIAGNOSTIC").
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react'
import { diag } from './diagnosticsBus'

const BUILD = 'v5'

// Pull the first stack frame that isn't this file's wrapper, so lastSrc points
// at the actual caller of scrollTo/scrollIntoView. Best-effort across engines.
function callerFrame(): string {
  const stack = (new Error().stack || '').split('\n').map(s => s.trim())
  const frame = stack.find(
    s => (s.startsWith('at ') || s.includes('@')) && !s.includes('callerFrame') && !s.includes('DiagnosticOverlay'),
  )
  return (frame || '-').replace(/^at\s+/, '').slice(0, 64)
}

export default function DiagnosticOverlay() {
  const [, force] = useState(0)
  const [mountedAt] = useState(() => performance.now())

  const scrollEventsRef = useRef(0)
  const lastScrollYRef = useRef(0)
  const firstNonZeroTRef = useRef<number | null>(null)

  // ── TEMP: window-scroll-source probe ──────────────────────────────────────
  // Wrap window.scrollTo + Element.prototype.scrollIntoView to count and trace
  // who scrolls the window during streaming. Forwards to the originals; restored
  // on unmount. Installed in a layout effect so it's in place as early as
  // possible. Changes NO scroll behavior.
  useEffect(() => {
    const origScrollTo = window.scrollTo
    const origIntoView = Element.prototype.scrollIntoView

    function patchedScrollTo(this: Window, ...args: any[]) {
      diag.winScrollToCalls++
      diag.lastScrollSrc = 'scrollTo<-' + callerFrame()
      return (origScrollTo as any).apply(this, args)
    }
    function patchedIntoView(this: Element, ...args: any[]) {
      diag.scrollIntoViewCalls++
      diag.lastScrollSrc = 'intoView<-' + callerFrame()
      return (origIntoView as any).apply(this, args)
    }

    ;(window as any).scrollTo = patchedScrollTo
    ;(Element.prototype as any).scrollIntoView = patchedIntoView

    return () => {
      window.scrollTo = origScrollTo
      Element.prototype.scrollIntoView = origIntoView
    }
  }, [])

  useEffect(() => {
    const noteFirstNonZero = () => {
      if (firstNonZeroTRef.current === null && window.scrollY > 0) {
        firstNonZeroTRef.current = Math.round(performance.now() - mountedAt)
      }
    }
    const onScroll = () => {
      scrollEventsRef.current += 1
      lastScrollYRef.current = Math.round(window.scrollY)
      noteFirstNonZero()
      force(n => n + 1)
    }
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
    ['listScrolls', diag.listScrolls],
    ['listKind', diag.lastListScrollKind],
    ['winScrollTo', diag.winScrollToCalls],
    ['intoView', diag.scrollIntoViewCalls],
    ['lastSrc', diag.lastScrollSrc],
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
        whiteSpace: 'pre-wrap',
        borderBottomRightRadius: '4px',
        maxWidth: '60vw',
        wordBreak: 'break-all',
      }}
    >
      {rows.map(([label, value]) => `${label}: ${value ?? 'n/a'}`).join('\n')}
    </div>
  )
}
