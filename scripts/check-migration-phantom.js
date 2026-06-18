// Preflight: block the known Prisma "phantom" migration statement.
//
// Prisma (v6) cannot model the GENERATED ALWAYS ... STORED tsvector column
// `JournalEntry.search` (created in raw SQL by 20260608140000_add_journal_fts,
// declared as `Unsupported("tsvector")?` in schema.prisma). On EVERY `migrate
// dev`, Prisma's diff misreads the generation expression as a column DEFAULT and
// auto-generates:
//
//     ALTER TABLE "JournalEntry" ALTER COLUMN "search" DROP DEFAULT;
//
// Postgres REJECTS this on a generated column (error 42601), so any migration
// containing it fails to apply (P3018). The standing workaround is to hand-remove
// the line from each generated migration (see 0610 / 0615 / 0618). This session it
// slipped through twice and broke the DB migration state. This tripwire makes it
// mechanically impossible to commit/apply a migration that still contains it.
//
// Checks raw filesystem bytes (not git state) so it also catches untracked or
// freshly hand-authored migrations. Whitespace/case tolerant and newline-spanning.
//
// IMPORTANT: only EXECUTABLE SQL is checked — SQL comments are stripped first.
// The precedent migrations (0610 / 0615 / 0618) deliberately DOCUMENT the phantom
// in `--` comments; those must pass. We only block the statement when it would
// actually run.
const fs = require('fs')
const path = require('path')

const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations')

// Collapse all runs of whitespace to a single space so an ALTER that Prisma
// splits across lines still matches. Two patterns:
//   strict — the exact phantom (DROP DEFAULT on JournalEntry.search)
//   loose  — any DROP DEFAULT on a column named "search" (the phantom's signature;
//            no legitimate migration drops the default on the generated tsvector)
const STRICT = /alter\s+table\s+"?JournalEntry"?\s+alter\s+column\s+"?search"?\s+drop\s+default/i
const LOOSE  = /alter\s+column\s+"?search"?\s+drop\s+default/i

// Strip block comments, then line comments (-- to end of line), then collapse
// whitespace — so a phantom quoted inside an explanatory comment never trips it,
// but an executable statement (however formatted) does.
function executableSql(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')                       // /* block comments */
    .split('\n')
    .map(line => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i) })
    .join(' ')
    .replace(/\s+/g, ' ')
}

const offenders = []

for (const entry of fs.readdirSync(migrationsDir)) {
  const file = path.join(migrationsDir, entry, 'migration.sql')
  if (!fs.existsSync(file)) continue
  const code = executableSql(fs.readFileSync(file, 'utf8'))
  if (STRICT.test(code) || LOOSE.test(code)) {
    offenders.push(path.relative(process.cwd(), file))
  }
}

if (offenders.length) {
  console.error('')
  console.error('############################################################')
  console.error('##  MIGRATION PHANTOM CHECK FAILED                        ##')
  console.error('############################################################')
  for (const f of offenders) {
    console.error('')
    console.error(`BLOCKED: migration ${f} contains the known phantom`)
    console.error(`'ALTER COLUMN "search" DROP DEFAULT' on the JournalEntry generated`)
    console.error(`tsvector column. Prisma auto-generates this and Postgres rejects it`)
    console.error(`(error 42601). Hand-remove this line from the migration before`)
    console.error(`committing/applying. See migrations 0610 / 0615 / 0618 for precedent.`)
  }
  console.error('')
  process.exit(1)
}

console.log('[preflight] migration phantom check OK — no JournalEntry.search DROP DEFAULT found.')
