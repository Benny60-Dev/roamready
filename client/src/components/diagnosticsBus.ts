// TEMP DIAGNOSTIC - REMOVE
// Shared mutable counters so SessionPage's empty->active edge effect can publish
// how often it runs / enters the justActivated branch, and DiagnosticOverlay can
// display them. Plain module-level object — no React state, no re-render coupling,
// changes NO scroll/layout behavior. To remove: delete this file and the two
// `diag.*++` lines in SessionPage plus the overlay rows (grep "TEMP DIAGNOSTIC").
export const diag = {
  edgeRuns: 0,       // increments every time the prevEmptyRef edge effect body runs
  justActivated: 0,  // increments only when the empty->active branch is entered
}
