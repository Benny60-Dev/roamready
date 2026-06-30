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
 * ─────────────────────────── THE FIX ───────────────────────────
 * On platforms that support file sharing (mobile Safari/Chrome), share the PDF
 * as a FILE-ONLY Web Share payload — `{ files: [file] }` with NO `url` and NO
 * `text`, so there is no URL for the share sheet to turn into a preview card.
 * On desktop / unsupported browsers, fall back to the classic anchor download.
 *
 * iOS gesture caveat: navigator.share must run inside the user-activation
 * window, but heavy PDF generation before this call can exceed it
 * (NotAllowedError). The share path is therefore best-effort: any FAILURE
 * falls back to the anchor download so the user is never left without the file.
 * A deliberate user CANCEL (AbortError) is NOT a failure — the sheet opened and
 * the user declined, so we do not force a download on them.
 */
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

  if (isTouchDevice && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] }) // FILES ONLY — never url/text
      return
    } catch (err) {
      // AbortError = the user opened the share sheet and cancelled; respect that
      // and do nothing. Any OTHER error (NotAllowedError from an expired gesture
      // window, or anything unexpected) → fall through to the download so the
      // user always ends up with the file.
      if (err instanceof DOMException && err.name === 'AbortError') return
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
