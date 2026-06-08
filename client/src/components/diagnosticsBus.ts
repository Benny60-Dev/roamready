// TEMP DIAGNOSTIC - REMOVE
// Shared mutable counters so SessionPage's effects can publish to the overlay
// without React coupling. Plain module-level object — no React state, no
// re-render coupling, changes NO scroll/layout behavior. To remove: delete this
// file, the `diag.*` lines in SessionPage, the scroll-source patch in
// DiagnosticOverlay, and the overlay rows (grep "TEMP DIAGNOSTIC").
export const diag = {
  edgeRuns: 0,             // prevEmptyRef edge effect body runs
  justActivated: 0,        // empty->active branch entered
  // Committed message-list auto-scroll effect:
  listScrolls: 0,          // times it executed a scroll
  lastListScrollKind: '-', // 'listRef.scrollTop' | 'scrollIntoView' | 'window'
  // Window-scroll source probe (monkey-patched in DiagnosticOverlay):
  winScrollToCalls: 0,     // window.scrollTo(...) call count
  scrollIntoViewCalls: 0,  // Element.scrollIntoView(...) call count
  lastScrollSrc: '-',      // top non-wrapper stack frame of the last such call
}
