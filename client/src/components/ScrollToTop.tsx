import { useLayoutEffect } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * Reset the document scroll to the top on every PAGE navigation.
 *
 * The app uses <BrowserRouter>, which (unlike a data-router with
 * <ScrollRestoration>) does NOT reset scroll on navigation. Without this, the
 * previous route's scrollTop carries over — e.g. scrolling down on Dashboard
 * then going Home left Home anchored mid-page with the greeting clipped above
 * the fold (a manual reload "fixed" it only because reload resets to 0).
 *
 * Fires on pathname change ONLY (dep [pathname]) — NOT on every render — so it
 * resets on page navigation but stays out of the way of in-page scrolling. In
 * particular it does not fight SessionPage's in-session scroll-to-bottom: that
 * scrolls an INTERNAL overflow-y-auto message list (a different scroll
 * container than the window), and it happens within a single pathname, so this
 * effect never runs for it. Switching sessions does change the pathname and
 * resets the window to 0, which is correct — the page shell shouldn't be
 * scrolled — while the chat list scrolls to the latest message on its own.
 *
 * useLayoutEffect (not useEffect) so the reset happens before paint, avoiding a
 * one-frame flash of the new page at the old scroll position. Renders nothing.
 */
export default function ScrollToTop() {
  const { pathname } = useLocation()

  useLayoutEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  return null
}
