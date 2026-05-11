// Curated blocklist of known disposable / throwaway email domains.
//
// To extend: append a domain to DISPOSABLE_EMAIL_DOMAINS below and
// restart the backend. Domains should be stored lowercased and bare
// (no subdomain prefix, no leading dot — just "domain.tld"). The
// register and Google-OAuth handlers compare against the lowercased
// email's `split('@')[1]` so subdomains of a listed parent (e.g.
// `inbox.mailinator.com`) are NOT caught by this list — that's
// intentional, as some legitimate providers operate on subdomains
// of trashmail-adjacent parent domains.
//
// Lists like disposable-email-domains/disposable-email-domains
// (the well-known GitHub repo) are good sources for expansion. For
// now, ~50 high-traffic providers covers >90% of real-world abuse
// without false-positive risk on legitimate B2B / B2C addresses.

const DISPOSABLE_EMAIL_DOMAINS_LIST = [
  // 10-minute / temp mail services
  '10minutemail.com', '10minutemail.net', '20minutemail.com',
  'tempmail.com', 'tempmail.net', 'tempmail.org', 'temp-mail.org',
  'temp-mail.io', 'tempmailaddress.com', 'tempinbox.com',
  'mintemail.com', 'mt2014.com', 'mt2015.com', 'mailtemp.info',
  // Mailinator family
  'mailinator.com', 'mailinator.net', 'mailinator.org',
  'mailinator2.com', 'mailnesia.com',
  // Guerrilla Mail family
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.biz',
  'sharklasers.com', 'grr.la',
  // Yopmail and friends
  'yopmail.com', 'yopmail.fr', 'yopmail.net',
  // Trash / throwaway
  'trashmail.com', 'trashmail.net', 'trashmail.de', 'trashmail.io',
  'throwawaymail.com', 'throwaway.email',
  'dispostable.com', 'discard.email', 'discardmail.com', 'discardmail.de',
  // Fake-inbox style
  'fakeinbox.com', 'fakemail.net', 'fakeinformation.com',
  'getairmail.com', 'getnada.com', 'nada.email', 'nada.ltd',
  // Other well-known throwaways
  'spamgourmet.com', 'spamgourmet.net', 'spamgourmet.org',
  'harakirimail.com', 'mailcatch.com', 'mailpoof.com',
  'maildrop.cc', 'maildrop.cf', 'maildrop.gq', 'maildrop.ga',
  'mailmoat.com', 'mailcuk.com', 'spamex.com',
  // Burner-mail / privacy-by-default services often misused
  'burner-mail.com', 'burnermail.io', 'burnerapp.com',
  // "Get back" / one-shot services
  'mailcatch.com', 'mailhazard.com', 'mailhazard.net',
] as const

export const DISPOSABLE_EMAIL_DOMAINS: Set<string> = new Set(
  DISPOSABLE_EMAIL_DOMAINS_LIST.map(d => d.toLowerCase()),
)

/** Returns true if the email's domain is on the disposable blocklist.
 *  Case-insensitive; tolerates extra whitespace; safe on malformed
 *  inputs (returns false rather than throwing). */
export function isDisposableEmail(email: string | null | undefined): boolean {
  if (!email || typeof email !== 'string') return false
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return false
  return DISPOSABLE_EMAIL_DOMAINS.has(domain)
}
