/**
 * Deliver a generated PDF blob to the user — shared by every PDF export path
 * (TripMapPage.handleExportPdf, TripSummaryPage.handleDownloadPDF).
 *
 * ─────────────────────────── THE iOS BUG ───────────────────────────
 * The old delivery was `<a href={URL.createObjectURL(blob)} download>` + click.
 * Desktop honors `download` and saves the file cleanly. iOS Safari does NOT —
 * it surfaces the blob object URL ("blob:https://roamready.ai/<uuid>") as the
 * shareable document, so an iMessage share attached the PDF AND a junk
 * link-preview card pointing at https://roamready.ai/<uuid> (a dead root-domain
 * URL whose OG tags render as "AI-Powered Outdoor Trip Planning").
 *
 * ─────────────────────────── DELIVERY ───────────────────────────
 * Desktop / non-touch: classic <a download> anchor — saves the file, never a
 * share panel. (canShare is true on desktop Chrome too, so we gate on a coarse
 * primary pointer + touchscreen, NOT canShare alone.)
 *
 * Touch / mobile: Web Share the PDF File AND a REAL "Try RoamReady" homepage
 * link, carried INLINE in the share `text` (not a separate `url:` field, which
 * iOS handles less reliably alongside files). This is NOT the old blob: leak —
 * that was a dead blob:https://roamready.ai/<uuid>; this is the live homepage,
 * intentionally re-added so a forwarded itinerary brings a working link along.
 *
 * Because iOS can reject or mishandle a files+text payload, delivery DEGRADES
 * through a cascade, never ending worse than a clean file share:
 *   [files + link]  →  [files only]  →  [anchor download]
 * The first two are gated by navigator.canShare(); a runtime share() FAILURE
 * (NotAllowedError from an expired gesture window, etc.) drops to the download.
 * A deliberate user CANCEL (AbortError) is respected — we do not force a save.
 */

// Single source of truth for the share link — easy to tweak later. A REAL,
// working URL (the live homepage) passed as a bare `url:` so iOS renders it as a
// preview card from roamready.ai's metadata — with NO separate message-text
// bubble (which a `text:` field would produce).
const SHARE_URL = 'https://roamready.ai'
const SHARE_TITLE = 'RoamReady trip'

export async function sharePdfBlob(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: 'application/pdf' })

  // Share only on genuine touch/mobile devices. canShare({ files }) is NOT
  // enough on its own — desktop Chrome (incl. Windows) reports it true and would
  // pop the OS Share panel instead of downloading. So additionally require a
  // COARSE primary pointer (phones/tablets) AND a real touchscreen; desktop
  // (even touchscreen laptops, whose primary pointer is fine) falls through to
  // the anchor download.
  const isTouchDevice =
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    window.matchMedia?.('(pointer: coarse)').matches === true &&
    (navigator.maxTouchPoints ?? 0) > 0

  if (isTouchDevice && typeof navigator !== 'undefined') {
    // Cascade: prefer file + real homepage link; if iOS won't accept that combo,
    // drop to the proven file-only payload; only then to the anchor download.
    const withLink: ShareData = { files: [file], url: SHARE_URL, title: SHARE_TITLE }
    const filesOnly: ShareData = { files: [file] }
    const payload: ShareData | null =
      navigator.canShare?.(withLink) ? withLink
      : navigator.canShare?.(filesOnly) ? filesOnly
      : null

    if (payload) {
      try {
        await navigator.share(payload)
        return
      } catch (err) {
        // AbortError = the user opened the share sheet and cancelled; respect
        // that and do nothing. Any OTHER error (NotAllowedError from an expired
        // gesture window, or anything unexpected) → fall through to the download
        // so the user always ends up with the file.
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
  }

  downloadViaAnchor(blob, filename)
}

function downloadViaAnchor(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } finally {
    URL.revokeObjectURL(url)
  }
}
