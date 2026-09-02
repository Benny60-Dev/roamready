#!/usr/bin/env node
// Generate LAUNCH_STATUS.md from launch-status.json (the source of truth).
//
//   node scripts/gen-status.mjs
//
// One direction only (JSON -> .md). Edit launch-status.json, never the .md.
// Deterministic: same JSON in -> byte-identical .md out. No external deps.
//
// Layout is data-driven: `meta.intro` supplies the paragraphs under the
// title, `sections[]` lists the tables in order (header, intro paragraphs,
// column spec), and each item's `category` names the section it renders in.
// Infrastructure (prose) and the maintain rules are fixed chrome at the end.
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

const byCategory = (cat) => data.items.filter((it) => it.category === cat);
const cell = (v) => (v == null || v === '' ? DASH : v);

function renderRow(it, columns) {
  return '| ' + columns.map((c) => cell(it[c.key])).join(' | ') + ' |';
}

const lines = [];

// ---- intro ----
lines.push('# Launch Status');
lines.push('');
lines.push(
  "**Source of truth for launch readiness. Update this file in the SAME commit as any fix that changes an item's status. Do not rely on chat recaps or memory for status.**"
);
lines.push('');
const intro =
  data.meta.intro && data.meta.intro.length
    ? data.meta.intro
    : [
        `Audit basis: every item below was verified against \`main\` on ${data.meta.verifiedDate} at commit ${data.meta.verifiedAgainstCommit} by inspecting the actual code, not by trusting prior notes or chat history.`,
      ];
for (const p of intro) {
  lines.push(p);
  lines.push('');
}
lines.push('---');
lines.push('');

// ---- table sections ----
for (const sec of data.sections) {
  lines.push(sec.header);
  lines.push('');
  for (const p of sec.intro || []) {
    lines.push(p);
    lines.push('');
  }
  lines.push('| ' + sec.columns.map((c) => c.label).join(' | ') + ' |');
  lines.push('|' + sec.columns.map((c) => '-'.repeat(c.label.length + 2)).join('|') + '|');
  for (const it of byCategory(sec.category)) lines.push(renderRow(it, sec.columns));
  lines.push('');
}

// ---- infrastructure (prose) ----
lines.push('---');
lines.push('');
lines.push('## Infrastructure');
lines.push('');
const infra = byCategory('infrastructure');
infra.forEach((it, i) => {
  if (i > 0) lines.push('');
  lines.push(`### ${it.title}`);
  if (it.evidence) for (const b of it.evidence.split('\n')) lines.push(b);
});
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
