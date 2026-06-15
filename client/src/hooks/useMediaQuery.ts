import { useEffect, useState } from 'react'

/**
 * Reactive media-query hook. Returns whether the given CSS media query
 * currently matches, and re-renders when that changes (resize, rotate,
 * devtools breakpoint). Pass a Tailwind-aligned query, e.g.
 * `useMediaQuery('(min-width: 640px)')` for the `sm` breakpoint.
 *
 * Initialized from matchMedia on mount so the first paint is already correct
 * (no flash of the wrong branch). SSR-safe: window may be absent on the very
 * first render, in which case it starts false and corrects in the effect.
 * Uses the modern `change` event (addEventListener), the same matchMedia
 * mechanism already used inline elsewhere in the app.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && 'matchMedia' in window
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange() // sync in case the query changed between render and effect
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
