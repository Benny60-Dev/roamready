#!/usr/bin/env node
// Generate LAUNCH_STATUS.md from launch-status.json (the source of truth).
//
//   node scripts/gen-status.mjs
//
// One direction only (JSON -> .md). Edit launch-status.json, never the .md.
// Deterministic: same JSON in -> byte-identical .md out. No external deps.
//
// The .md is written with CRLF line endings to match the existing checked-in
// LAUNCH_STATUS.md (the repo stores this file CRLF; .gitattributes only pins
// prisma SQL to LF, and core.autocrlf is false).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(root, 'launch-status.json'), 'utf8'));

const EOL = '\r\n';
const DASH = '—'; // em dash, used as the empty-cell placeholder

// Document layout the generator owns. Section headers are fixed chrome; all
// data-bearing values come from the JSON.
const TABLE_SECTIONS = [
  { category: 'launch-blocking', header: '## Launch-blocking', cols: 5 },
  {
    category: 'open-bug',
    header: '## Open — road-logged bugs (found 2026-06-05; not yet scouted/fixed)',
    cols: 5,
  },
  { category: 'done', header: '## Done — keep verified', cols: 4 },
  { category: 'post-launch', header: '## Post-launch (deferred)', cols: 5 },
];

const HEADER_5 = '| # | Item | Status | Evidence | What remains |';
const SEP_5 = '|---|------|--------|----------|--------------|';
const HEADER_4 = '| # | Item | Status | Evidence |';
const SEP_4 = '|---|------|--------|----------|';

const byCategory = (cat) => data.items.filter((it) => it.category === cat);
const cell = (v) => (v == null || v === '' ? DASH : v);

function renderRow(it, cols) {
  const cells = [it.id, it.title, it.statusRaw, cell(it.evidence)];
  if (cols === 5) cells.push(cell(it.whatRemains));
  return '| ' + cells.join(' | ') + ' |';
}

const lines = [];

// ---- intro ----
lines.push('# Launch Status');
lines.push('');
lines.push(
  "**Source of truth for launch readiness. Update this file in the SAME commit as any fix that changes an item's status. Do not rely on chat recaps or memory for status.**"
);
lines.push('');
lines.push(
  `Audit basis: every item below was verified against \`main\` on ${data.meta.verifiedDate} at commit ${data.meta.verifiedAgainstCommit} by inspecting the actual code, not by trusting prior notes or chat history.`
);
lines.push('');
lines.push('---');
lines.push('');

// ---- table sections ----
for (const sec of TABLE_SECTIONS) {
  lines.push(sec.header);
  lines.push('');
  lines.push(sec.cols === 5 ? HEADER_5 : HEADER_4);
  lines.push(sec.cols === 5 ? SEP_5 : SEP_4);
  for (const it of byCategory(sec.category)) lines.push(renderRow(it, sec.cols));
  lines.push('');
}

// ---- infrastructure (prose) ----
lines.push('---');
lines.push('');
lines.push('## Infrastructure');
lines.push('');
for (const it of byCategory('infrastructure')) {
  lines.push(`### ${it.title}`);
  if (it.evidence) for (const b of it.evidence.split('\n')) lines.push(b);
}
lines.push('');

// ---- how to maintain ----
lines.push('---');
lines.push('');
lines.push('## How to maintain this file');
lines.push('');
for (const rule of data.maintainRules) lines.push(`- ${rule}`);

const out = lines.join(EOL) + EOL;
writeFileSync(join(root, 'LAUNCH_STATUS.md'), out, 'utf8');
console.log(`Wrote LAUNCH_STATUS.md (${out.length} bytes, ${lines.length} lines, CRLF).`);
