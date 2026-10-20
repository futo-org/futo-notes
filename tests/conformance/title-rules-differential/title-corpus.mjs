/**
 * Probe inputs for the title family (filename.json): titles, folder paths, collisions.
 */

import { CASE_TRAPS, PARTY, sample, unique, xorshift32 } from './seeded-random-and-charsets.mjs';

// --- Family: title (filename.json) -----------------------------------------

/**
 * The title corpus. The sections up to and including the fixed-seed mixtures are
 * byte-identical to the original title-only differential (same order, same seed,
 * same alphabet) so the 2,432 inputs that caught the escaped-C1 divergence keep
 * catching it; everything after that is additive.
 */
export function titleCorpus() {
  const titles = [];
  const seen = new Set();
  const add = (title) => {
    if (seen.has(title)) return;
    seen.add(title);
    titles.push(title);
  };

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
    `note ${PARTY} title`,
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
    PARTY,
  ];
  const rng = xorshift32(0x5eed1234);
  for (let caseIndex = 0; caseIndex < 2048; caseIndex += 1) {
    add(sample(rng, alphabet, rng() % 65));
  }

  // Length boundaries around MAX_TITLE_LENGTH (200), counted in UTF-16 units on
  // both sides - an astral char is two units, so these straddle the limit in a way
  // a pure-ASCII corpus never reaches.
  for (const length of [199, 200, 201]) {
    add('a'.repeat(length));
    add(`${'a'.repeat(length - 1)}${PARTY}`);
    add(PARTY.repeat(Math.floor(length / 2)));
  }

  // Case-mapping traps, bare and with an extension (the Windows-reserved check
  // upper-cases only the pre-dot stem).
  for (const trap of CASE_TRAPS) {
    add(trap);
    add(`${trap}.md`);
    add(`CON${trap}`);
  }

  return titles;
}

/** Folder-path shapes: depth, empty/dot components, slash runs, bad names. */
export function folderPathCorpus() {
  const segments = [
    'a',
    'A',
    'CON',
    'con.md',
    'nul.txt',
    '.hidden',
    'trail.',
    '..',
    '.',
    '',
    ' ',
    'sp ace',
    'a<b',
    'ünïcode',
    'Ω',
    PARTY,
    '\t',
    'x'.repeat(201),
  ];
  const paths = [];
  for (const segment of segments) {
    paths.push(segment, `/${segment}`, `${segment}/`, `//${segment}//`);
    for (const other of segments) paths.push(`${segment}/${other}`);
  }
  // Depth boundary: MAX_FOLDER_DEPTH is 10, so 9/10/11 components straddle it.
  for (let depth = 0; depth <= 13; depth += 1) {
    paths.push(Array.from({ length: depth }, (_, index) => `d${index}`).join('/'));
  }
  paths.push('', '/', '//', '///', 'a//b', 'a/./b', 'a/../b', '../../etc/passwd');
  const rng = xorshift32(0x0f01de12);
  for (let index = 0; index < 300; index += 1) {
    const depth = rng() % 14;
    paths.push(Array.from({ length: depth }, () => segments[rng() % segments.length]).join('/'));
  }
  return unique(paths);
}

/** `{ name, siblings }` pairs, weighted toward case-folding traps. */
export function collisionCorpus() {
  const names = ['Specs', 'specs', 'SPECS', 'Other', '', ' ', ...CASE_TRAPS];
  const cases = [];
  for (const name of names) {
    cases.push({ name, siblings: [] });
    cases.push({ name, siblings: [name] });
    cases.push({ name, siblings: ['unrelated', 'Notes'] });
    for (const sibling of names) cases.push({ name, siblings: [sibling] });
    cases.push({ name, siblings: [...names] });
  }
  return cases;
}
