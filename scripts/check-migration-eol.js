// Preflight: prisma migration SQL must be LF on disk.
//
// `prisma migrate` records a sha256 of each migration file's BYTES at apply
// time. A CRLF rewrite (core.autocrlf, an editor, a pre-pin checkout) flips
// the checksum and `migrate dev` then reports "migration was modified after
// it was applied" — offering a destructive DB reset. This repo pins
// prisma/migrations/**/*.sql to eol=lf in .gitattributes AND sets repo-local
// core.autocrlf=false; this script is the tripwire in case anything slips
// past both (run it from ANY checkout/worktree before committing or running
// prisma migrate).
//
// Checks raw filesystem bytes (not git state) so it also catches untracked
// or freshly hand-authored migrations. Exits 1 loudly on any CRLF.
const fs = require('fs')
const path = require('path')

const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations')
const offenders = []

for (const entry of fs.readdirSync(migrationsDir)) {
  const file = path.join(migrationsDir, entry, 'migration.sql')
  if (!fs.existsSync(file)) continue
  if (fs.readFileSync(file).includes('\r\n')) offenders.push(path.relative(process.cwd(), file))
}

if (offenders.length) {
  console.error('')
  console.error('############################################################')
  console.error('##  MIGRATION EOL CHECK FAILED — CRLF detected!           ##')
  console.error('##                                                        ##')
  console.error('##  These migration files have CRLF line endings, which  ##')
  console.error('##  breaks their applied checksums and makes `prisma     ##')
  console.error('##  migrate dev` offer a DESTRUCTIVE DB RESET. Do NOT    ##')
  console.error('##  reset. Convert the files back to LF (and never run   ##')
  console.error('##  this repo with core.autocrlf=true):                  ##')
  console.error('############################################################')
  for (const f of offenders) console.error('  CRLF: ' + f)
  console.error('')
  process.exit(1)
}

console.log(`[preflight] migration EOL check OK — all migration.sql files are LF.`)
