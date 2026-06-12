import { Request } from 'express'

// When requests arrive via Vite's dev proxy (e.g. from http://10.0.0.214:3000),
// the proxy sets x-forwarded-host to the original hostname:port.
// This lets server-side redirects go back to the correct host instead of localhost.
export function getClientOrigin(req: Request): string {
  // Prefer the explicitly-configured client origin. In production requests
  // arrive through a Render rewrite, so x-forwarded-host is the API's own
  // host — deriving the origin from it would point users at the API (which
  // has no client routes) instead of the client. CLIENT_URL is the source of
  // truth when set; the x-forwarded-host derivation is only a fallback for
  // environments where CLIENT_URL isn't configured.
  if (process.env.CLIENT_URL) {
    return process.env.CLIENT_URL
  }
  const fwdHost = req.headers['x-forwarded-host']
  if (fwdHost) {
    const host = Array.isArray(fwdHost) ? fwdHost[0] : fwdHost
    const proto = Array.isArray(req.headers['x-forwarded-proto'])
      ? req.headers['x-forwarded-proto'][0]
      : (req.headers['x-forwarded-proto'] as string | undefined) || 'http'
    return `${proto}://${host}`
  }
  return 'http://localhost:3000'
}
