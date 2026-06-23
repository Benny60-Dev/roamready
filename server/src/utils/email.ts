// Single source of truth for email normalization. Postgres compares the
// `email` text column case-sensitively, which historically let "Cindy@" and
// "cindy@" coexist as two accounts and let a user who signed up as "Cindy@"
// fail to log in as "cindy@". Every write path lowercases before persisting
// and every lookup path lowercases the typed input before comparing, so the
// plain unique index behaves case-insensitively without citext. Keep this the
// ONLY place that decides what "normalized" means — call sites import this
// helper rather than inlining .toLowerCase().
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}
