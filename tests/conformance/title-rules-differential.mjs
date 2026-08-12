// Test-only differential conformance for the synchronous title-rule twin.
//
// The checked-in filename.json cases are the reviewed behavioral truth. This
// larger generated corpus has a different job: ask the TypeScript and Rust
// implementations the same questions and fail when their answers differ.
// Rust is started once and receives the whole corpus as one JSON batch.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { sanitizeTitle, validateTitle } from '../../packages/editor/src/filename.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const titles = [];
const seen = new Set();

function add(title) {
  if (seen.has(title)) return;
  seen.add(title);
  titles.push(title);
}

for (const title of [
  '',
  'normal title',
  'CON',
  'CON.bak',
  'a. .',
  '. .. .',
  '. . .',
  '  . a. . .  ',
  'a<b>c:d"e|f?g*h',
  'café résumé',
  'note 🎉 title',
]) {
  add(title);
}

// Exhaust the C0/DEL/C1 region and the neighboring Latin-1 block that exposed
// the escaped C1 divergence.
for (let codePoint = 0; codePoint <= 0xff; codePoint += 1) {
  add(`a${String.fromCodePoint(codePoint)}b`);
}

// Exercise whitespace and formatting characters outside Latin-1 explicitly.
for (const codePoint of [
  0x1680, 0x180e, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x200b, 0x2028, 0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff,
]) {
  add(`a${String.fromCodePoint(codePoint)}b`);
  add(`${String.fromCodePoint(codePoint)}a${String.fromCodePoint(codePoint)}`);
}

for (let groups = 1; groups <= 32; groups += 1) {
  add(`a${'. '.repeat(groups)}`);
  add('. '.repeat(groups));
  add(`${' .'.repeat(groups)}a${'. '.repeat(groups)}`);
}

for (const stem of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
  for (const spelling of [stem, stem.toLowerCase(), `${stem}.md`, `${stem}.bak`]) {
    add(spelling);
  }
}

// Deterministic adversarial mixtures. The fixed seed makes failures
// reproducible while sampling combinations too numerous to hand-author.
const alphabet = [
  'a',
  'Z',
  '0',
  '.',
  ' ',
  '\t',
  '\n',
  '<',
  '>',
  ':',
  '"',
  '/',
  '\\',
  '|',
  '?',
  '*',
  '\x00',
  '\x1f',
  '\x7f',
  '\x85',
  '\x9f',
  '\u00a0',
  '\u2003',
  'é',
  'Ω',
  'ب',
  '🎉',
];
let state = 0x5eed1234;
function randomU32() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}
for (let caseIndex = 0; caseIndex < 2048; caseIndex += 1) {
  const length = randomU32() % 65;
  let title = '';
  for (let index = 0; index < length; index += 1) {
    title += alphabet[randomU32() % alphabet.length];
  }
  add(title);
}

const rust = spawnSync(
  'cargo',
  ['run', '--quiet', '-p', 'futo-notes-model', '--example', 'title_rule_oracle'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(titles),
    maxBuffer: 32 * 1024 * 1024,
  },
);
if (rust.status !== 0) {
  process.stderr.write(rust.stderr);
  process.exit(rust.status ?? 1);
}

const rustOutcomes = JSON.parse(rust.stdout);
const mismatches = [];
for (let index = 0; index < titles.length; index += 1) {
  const title = titles[index];
  const typescript = {
    sanitized: sanitizeTitle(title),
    issueKinds: validateTitle(title).map((issue) => issue.kind),
  };
  const rustOutcome = rustOutcomes[index];
  if (JSON.stringify(typescript) !== JSON.stringify(rustOutcome)) {
    mismatches.push({ title, typescript, rust: rustOutcome });
    if (mismatches.length === 20) break;
  }
}

if (mismatches.length > 0) {
  process.stderr.write(
    `Title-rule differential conformance found ${mismatches.length} mismatch(es):\n` +
      `${JSON.stringify(mismatches, null, 2)}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Title-rule differential conformance OK (${titles.length} structured inputs).\n`,
);
