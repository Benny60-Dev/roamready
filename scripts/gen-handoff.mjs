#!/usr/bin/env node
// Generate SESSION_HANDOFF.md from launch-status.json (the source of truth).
//
//   node scripts/gen-handoff.mjs
//
// HYBRID file with two clearly-delimited halves:
//   1. GENERATED  — the factual, drift-prone half, derived from launch-status.json.
//                   Rewritten in full on every run; never hand-edit it.
//   2. NARRATIVE  — the session-story half, hand-filled at wrap time.
//                   The generator NEVER touches anything from the narrative
//                   banner down: on regen it splices a fresh GENERATED block in
//                   above the banner and preserves the narrative half byte-for-byte.
//
// Node ESM, no external deps, deterministic. CRLF line endings to match the
// repo's other generated doc (LAUNCH_STATUS.md); see gen-status.mjs for why.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(root, 'launch-status.json'), 'utf8'));
const HANDOFF = join(root, 'SESSION_HANDOFF.md');

const EOL = '\r\n';

const GEN_START =
  '<!-- GENERATED FROM launch-status.json — do not hand-edit this section; it is overwritten on every regen -->';
const GEN_END = '<!-- END GENERATED -->';
const NARRATIVE_BANNER =
  '<!-- SESSION NARRATIVE — fill this in at wrap time; the generator never touches below this line -->';

const items = data.items;
// Open = anything OPEN, plus any launch-blocking item that isn't DONE (a live blocker).
const isOpen = (it) => it.status === 'OPEN' || (it.category === 'launch-blocking' && it.status !== 'DONE');
const isDeferred = (it) => it.status === 'DEFERRED' || it.status === 'PARTIAL';
// A RESOLVED infra item is settled, so it reads alongside DONE rather than vanishing.
const isDone = (it) => it.status === 'DONE' || it.status === 'RESOLVED';

const openItems = items.filter(isOpen);
const deferredItems = items.filter(isDeferred);
const doneItems = items.filter(isDone);

function bullet(it, withStatus) {
  // Items without an id (e.g. infrastructure) render title-only — never "null — ".
  let line = it.id ? `- ${it.id} — ${it.title}` : `- ${it.title}`;
  if (withStatus) line += ` (${it.statusRaw})`;
  if (it.commits && it.commits.length) line += ` — commits: ${it.commits.join(', ')}`;
  return line;
}

const listOrNone = (arr, withStatus) =>
  arr.length ? arr.map((it) => bullet(it, withStatus)) : ['- _(none)_'];

// The GENERATED half: title + banner-delimited factual block, ending with the
// END banner and one trailing blank line (so the narrative banner that follows
// always sits one blank line below it).
function buildGeneratedHalf() {
  const L = [];
  L.push('# Session Handoff');
  L.push(GEN_START);
  L.push('');
  L.push(
    `**Status as of ${data.meta.verifiedDate}** — verified against \`main\` @ \`${data.meta.verifiedAgainstCommit}\`.`
  );
  L.push('');
  L.push('## Open items');
  L.push(...listOrNone(openItems, true));
  L.push('');
  L.push('## Deferred / post-launch');
  L.push(...listOrNone(deferredItems, true));
  L.push('');
  L.push('## Done — verified');
  L.push(...listOrNone(doneItems, false));
  L.push('');
  L.push(GEN_END);
  L.push('');
  return L.join(EOL) + EOL;
}

// The NARRATIVE half scaffold — written only when there is nothing to preserve.
function buildNarrativeScaffold() {
  const L = [];
  L.push(NARRATIVE_BANNER);
  L.push('');
  L.push('## Working rules');
  L.push('<!-- hint: standing rules for how to work this session — env safety, git flow, what not to touch -->');
  L.push('');
  L.push('## What shipped this session (prose)');
  L.push('<!-- hint: narrative of what changed this session and why, in your own words -->');
  L.push('');
  L.push('## Watch / lessons logged');
  L.push('<!-- hint: gotchas, near-misses, and lessons to carry into next session -->');
  L.push('');
  L.push('## First actions next session');
  L.push('<!-- hint: the first concrete steps to take when you resume -->');
  return L.join(EOL) + EOL;
}

const generatedHalf = buildGeneratedHalf();

let narrativeHalf;
let mode;
if (existsSync(HANDOFF)) {
  const existing = readFileSync(HANDOFF, 'utf8');
  const idx = existing.indexOf(NARRATIVE_BANNER);
  if (idx !== -1) {
    // Preserve everything from the narrative banner down, byte-for-byte.
    narrativeHalf = existing.slice(idx);
    mode = 'spliced (narrative preserved)';
  } else {
    // Existing file is missing the banner (corrupted/legacy) — can't locate the
    // boundary, so write a fresh scaffold and warn rather than guess.
    narrativeHalf = buildNarrativeScaffold();
    mode = 'rewritten (no narrative banner found — fresh scaffold)';
    console.warn('WARNING: SESSION_HANDOFF.md existed but had no SESSION NARRATIVE banner; wrote a fresh scaffold.');
  }
} else {
  narrativeHalf = buildNarrativeScaffold();
  mode = 'created (new scaffold)';
}

const out = generatedHalf + narrativeHalf;
writeFileSync(HANDOFF, out, 'utf8');
console.log(`Wrote SESSION_HANDOFF.md (${out.length} bytes, CRLF) — ${mode}.`);
console.log(`  open: ${openItems.length}, deferred/partial: ${deferredItems.length}, done: ${doneItems.length}`);
