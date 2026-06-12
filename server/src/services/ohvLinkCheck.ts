import axios from 'axios'
import { readFileSync } from 'fs'
import path from 'path'

// Monthly OHV link-checker. Reads the monitored copy of the OHV URL list
// (server/src/data/ohvLinks.json — a manual copy of the client constants in
// client/src/constants/ohvStateResources.ts; the server can't import the
// client package) and pings each URL, classifying it OK / DEAD / REVIEW.
//
// THREE-STATE RESULT: a bare 403 is ambiguous — WAF-protected live pages AND
// genuinely dead hosts both return it (Kansas was dead behind a 403 and nearly
// slipped through a binary checker). So we classify into three states and
// surface REVIEW links to a human instead of silently passing OR crying wolf.
//
// DRIFT LIMITATION: a reliable cross-package import of the client list isn't
// available (separate packages, Vite build), so we can't auto-diff against it.
// Instead we hard-code the expected count and warn if the JSON diverges. This
// is intentionally coarse (count only) — a richer diff would need a shared
// package or a build step, not worth it for a monthly maintenance job. If you
// add/remove a state in the client list, regenerate the JSON and bump this.
//
// 97 = 4 national + 50 state authorities (ohvStateResources.ts) + 43 unique
// supplemental links (ohvStateExtraLinks.ts, de-duplicated by URL).
const EXPECTED_LINK_COUNT = 97

const REQUEST_TIMEOUT_MS = 15_000
const BATCH_SIZE = 6 // be polite to .gov servers — check in small batches

// Browser User-Agent. Many WAFs (Akamai/Cloudflare fronting .gov hosts) reject
// non-browser agents with a 403; sending a real browser UA cuts false 403s at
// the source so fewer links land in REVIEW for no reason.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// Hosts confirmed live-behind-WAF by manual browser check. A 403 from these is
// treated OK. Do NOT add a host without a human verifying it loads in a browser
// first — Kansas (ksoutdoors.gov) returned 403 while genuinely DEAD, so 403
// alone is never proof of life.
const KNOWN_WAF_HOSTS = ['mass.gov', 'tn.gov', 'wildlife.nh.gov']

export type LinkState = 'OK' | 'DEAD' | 'REVIEW'

export interface OhvLink {
  label: string
  url: string
}

export interface LinkResult {
  label: string
  url: string
  state: LinkState
  status: number | string // HTTP status, an error code (e.g. ENOTFOUND), or 'NO_RESPONSE'
  finalUrl?: string // present only when the request was redirected elsewhere
}

export interface OhvLinkCheckResult {
  checkedAt: string
  total: number
  okCount: number
  deadCount: number
  reviewCount: number
  dead: LinkResult[]
  review: LinkResult[]
  driftWarning?: string
}

function loadLinks(): OhvLink[] {
  const file = path.resolve(__dirname, '../data/ohvLinks.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { links?: OhvLink[] }
  return Array.isArray(parsed.links) ? parsed.links : []
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// Last two dot-labels, lowercased — a registrable-domain heuristic that is
// correct for the all-US .gov/.org/.com URLs we monitor (not multi-part public
// suffixes like .co.uk). Used to detect off-domain redirects: www. <-> apex and
// sub.domain stay "same domain"; a hop to a different registrable domain (parked
// page, link shortener, "domain for sale") is treated as DEAD.
function registrableDomain(host: string): string {
  const parts = host.split('.').filter(Boolean)
  return parts.length <= 2 ? host : parts.slice(-2).join('.')
}

// Suffix match so www. + any subdomain of an allowlisted host are covered
// (e.g. 'wildlife.nh.gov' matches www.wildlife.nh.gov but NOT bare nh.gov).
function isKnownWafHost(url: string): boolean {
  const host = hostOf(url)
  return KNOWN_WAF_HOSTS.some(w => host === w || host.endsWith('.' + w))
}

function finalUrlOf(res: any): string | undefined {
  // axios (Node, via follow-redirects) exposes the final URL after redirects here.
  return res?.request?.res?.responseUrl ?? undefined
}

function classify(url: string, status: number, finalUrl?: string): LinkState {
  // Off-domain redirect → DEAD: the link no longer lands where it claims to.
  if (finalUrl) {
    const from = registrableDomain(hostOf(url))
    const to = registrableDomain(hostOf(finalUrl))
    if (from && to && from !== to) return 'DEAD'
  }
  if (status >= 200 && status < 300) return 'OK'
  if (status === 404 || status === 410) return 'DEAD'
  // A 403 from a host we've confirmed live-behind-WAF in a browser → OK.
  if (status === 403 && isKnownWafHost(url)) return 'OK'
  // 401 / 403 / 429 / 5xx / any other ambiguous non-2xx → human glance needed.
  return 'REVIEW'
}

// HEAD first (cheap); some servers reject HEAD (403/405), so fall back to GET.
// validateStatus is permissive so axios never throws on an HTTP status — we
// classify the status ourselves. Only network-level failures (DNS, connection
// refused, timeout, redirect loop) throw, and those are unambiguously DEAD.
async function checkOne(link: OhvLink): Promise<LinkResult> {
  const cfg = {
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { 'User-Agent': BROWSER_UA },
  }
  let res: any
  try {
    res = await axios.head(link.url, cfg)
    if (res.status >= 400) res = await axios.get(link.url, cfg) // host may reject HEAD only
  } catch {
    try {
      res = await axios.get(link.url, cfg)
    } catch (err: any) {
      // DNS failure / connection refused / timeout / too many redirects → DEAD.
      const status: number | string = err?.code ?? 'NO_RESPONSE'
      return { label: link.label, url: link.url, state: 'DEAD', status }
    }
  }
  const finalUrl = finalUrlOf(res)
  const state = classify(link.url, res.status, finalUrl)
  const out: LinkResult = { label: link.label, url: link.url, state, status: res.status }
  if (finalUrl && finalUrl !== link.url) out.finalUrl = finalUrl
  return out
}

/** Check every OHV link in small concurrent batches and return a structured
 *  three-state result. Never throws on a bad link — failures are collected
 *  into `dead` / `review`. */
export async function runOhvLinkCheck(): Promise<OhvLinkCheckResult> {
  const links = loadLinks()
  const dead: LinkResult[] = []
  const review: LinkResult[] = []
  let okCount = 0

  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(checkOne))
    for (const r of results) {
      if (r.state === 'OK') okCount++
      else if (r.state === 'DEAD') dead.push(r)
      else review.push(r)
    }
  }

  const total = links.length
  const result: OhvLinkCheckResult = {
    checkedAt: new Date().toISOString(),
    total,
    okCount,
    deadCount: dead.length,
    reviewCount: review.length,
    dead,
    review,
  }
  if (total !== EXPECTED_LINK_COUNT) {
    result.driftWarning =
      `ohvLinks.json has ${total} entries but EXPECTED_LINK_COUNT is ${EXPECTED_LINK_COUNT} — ` +
      'the monitored copy may be out of sync with the client list (client/src/constants/ohvStateResources.ts).'
  }
  return result
}
