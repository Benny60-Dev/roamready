import { useLayoutEffect } from 'react'

/**
 * Reset the window scroll to the top the moment a page transitions from its
 * loading/hydrating state to ready (its tall real content mounts).
 *
 * The global <ScrollToTop> resets scroll on pathname change, but it fires once
 * — and if a page shows a SHORT loader first and mounts TALL content a tick
 * later, that reset lands on the spinner. The tall content then mounts and the
 * browser's scroll-anchoring can bump scrollTop up, opening the page scrolled
 * past the top (seen on the post-login Home landing). Re-applying the reset on
 * the not-loading → ready edge lands it on the real content.
 *
 * Pass the READY boolean (e.g. `!loading` / `!hydrating`). useLayoutEffect
 * runs before paint, so the page is already at the top on the first visible
 * frame — no jump/snap. The dep is `ready`, so it only fires on the edge (and
 * again if the page re-enters loading then becomes ready), never on unrelated
 * re-renders. Resets the WINDOW only — components with their own internal
 * scroll containers are unaffected.
 */
export function useScrollResetOnReady(ready: boolean) {
  useLayoutEffect(() => {
    if (ready) window.scrollTo(0, 0)
  }, [ready])
}
