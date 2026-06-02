import axios from 'axios'
import { readFileSync } from 'fs'
import path from 'path'

// Monthly OHV link-checker. Reads the monitored copy of the OHV URL list
// (server/src/data/ohvLinks.json — a manual copy of the client constants in
// client/src/constants/ohvStateResources.ts; the server can't import the
// client package) and pings each URL, reporting any that are dead.
//
// DRIFT LIMITATION: a reliable cross-package import of the client list isn't
// available (separate packages, Vite build), so we can't auto-diff against it.
// Instead we hard-code the expected count and warn if the JSON diverges. This
// is intentionally coarse (count only) — a richer diff would need a shared
// package or a build step, not worth it for a monthly maintenance job. If you
// add/remove a state in the client list, regenerate the JSON and bump this.
//
// 98 = 4 national + 50 state authorities (ohvStateResources.ts) + 44 unique
// supplemental links (ohvStateExtraLinks.ts, de-duplicated by URL).
const EXPECTED_LINK_COUNT = 98

const REQUEST_TIMEOUT_MS = 10_000
const BATCH_SIZE = 6 // be polite to .gov servers — check in small batches

export interface OhvLink {
  label: string
  url: string
}

export interface DeadLink {
  label: string
  url: string
  status: number | string // HTTP status, or an error code / 'NO_RESPONSE'
}

export interface OhvLinkCheckResult {
  checkedAt: string
  total: number
  okCount: number
  deadCount: number
  dead: DeadLink[]
  driftWarning?: string
}

function loadLinks(): OhvLink[] {
  const file = path.resolve(__dirname, '../data/ohvLinks.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { links?: OhvLink[] }
  return Array.isArray(parsed.links) ? parsed.links : []
}

// HEAD first (cheap); some .gov servers reject HEAD (405/403/network), so fall
// back to GET. axios follows redirects by default and validateStatus<400 makes
// it resolve only on a final 2xx/3xx — anything else (thrown error, >=400,
// timeout, DNS failure) is treated as DEAD.
async function checkOne(link: OhvLink): Promise<DeadLink | null> {
  const cfg = {
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (s: number) => s < 400,
    headers: { 'User-Agent': 'RoamReady-LinkChecker/1.0 (+https://roamready.ai)' },
  }
  try {
    await axios.head(link.url, cfg)
    return null
  } catch {
    try {
      await axios.get(link.url, cfg)
      return null
    } catch (err: any) {
      const status: number | string = err?.response?.status ?? err?.code ?? 'NO_RESPONSE'
      return { label: link.label, url: link.url, status }
    }
  }
}

/** Check every OHV link in small concurrent batches and return a structured
 *  result. Never throws on a dead link — failures are collected into `dead`. */
export async function runOhvLinkCheck(): Promise<OhvLinkCheckResult> {
  const links = loadLinks()
  const dead: DeadLink[] = []

  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(checkOne))
    for (const r of results) if (r) dead.push(r)
  }

  const total = links.length
  const deadCount = dead.length
  const result: OhvLinkCheckResult = {
    checkedAt: new Date().toISOString(),
    total,
    okCount: total - deadCount,
    deadCount,
    dead,
  }
  if (total !== EXPECTED_LINK_COUNT) {
    result.driftWarning =
      `ohvLinks.json has ${total} entries but EXPECTED_LINK_COUNT is ${EXPECTED_LINK_COUNT} — ` +
      'the monitored copy may be out of sync with the client list (client/src/constants/ohvStateResources.ts).'
  }
  return result
}
