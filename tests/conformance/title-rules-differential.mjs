// The TypeScript<->Rust note-rule differential.
//
// The checked-in `tests/conformance/*.json` corpora are the reviewed behavioral
// truth: a human decided what each rule SHOULD answer for a few hundred inputs.
// This file has a different job. It asks the TypeScript copy and the canonical
// Rust implementation the SAME tens of thousands of questions and fails when
// their answers differ - no expectations to author, no goldens to regenerate,
// and no way for a rule to drift in one language and stay green in the other.
//
//   node --experimental-strip-types tests/conformance/title-rules-differential.mjs
//   ... --family=tags --family=preview   # narrow while debugging (PARTIAL run)
//   ... --all                            # print every disagreement, not the first 25
//
// Reached by `just test-rust`, `just test-rust-full`, and CI's
// `test:rust:workspace`. Full orientation - what each corpus is, how to add a
// case or a family, what this supersedes - is in `tests/conformance/README.md`.
//
// Properties this file must keep:
//   * DETERMINISTIC. Fixed-seed xorshift only; never `Math.random()`, never the
//     clock. A red run must reproduce byte-for-byte on the next run.
//   * ONE Rust process. The whole corpus goes to the oracle
//     (`crates/futo-notes-model/examples/title_rule_oracle.rs`) as a single JSON
//     batch, so growing the corpus costs microseconds, not cargo startups.
//   * NO SILENT PASS (M11). `assertEveryFixtureOpIsCovered` fails if a fixture op
//     exists that this differential does not probe, and every KNOWN_DIVERGENCES
//     entry prints its suppressed count even on a green run - a divergence nobody
//     sees is a divergence nobody fixes.
//
// The filename is historical: this began as a title-only differential and the
// `justfile`, `.gitlab-ci.yml`, and `scripts/drift-registry.json` all reference
// this path. It now covers every rule family the fixtures cover.
//
// EVERY non-printable-ASCII code point below is written as a `\uXXXX` escape, on
// purpose. A literal zero-width or non-breaking character in source is
// unreviewable and is silently normalized by some editors - which weakens the
// corpus without failing anything.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  sanitizeTitle,
  validateTitle,
  isValidTitle,
  isWindowsReservedName,
  validateFolderName,
  isValidFolderName,
  hasCaseInsensitiveSiblingCollision,
  validateFolderPath,
  isValidFolderPath,
  pathDepth,
} from '../../packages/editor/src/filename.ts';
import {
  tagRegexMatches,
  isValidTagName,
  normalizeTagName,
  extractTags,
  extractHeaderTagBlock,
} from '../../packages/editor/src/tags.ts';
import { makePreview } from '../../packages/editor/src/preview.ts';
import { isImageFilename, IMAGE_EXTENSIONS } from '../../packages/editor/src/images.ts';
import {
  resolveWikilink,
  shortestUniqueSuffix,
  rewriteWikilinks,
} from '../../src/shared/note/wikilinks.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

// --- The TypeScript side of every cross-language op -------------------------
//
// Keys are the language-neutral verbs the fixtures use and the Rust dispatcher
// (`crates/futo-notes-model/tests/support/rule_ops.rs`) answers. Every value must
// return plain JSON - the comparison is structural, not by identity.

const TS_OPS = {
  // filename.ts - titles
  sanitizeTitle: (input) => sanitizeTitle(input),
  validateTitle: (input) => validateTitle(input).map((issue) => issue.kind),
  isValidTitle: (input) => isValidTitle(input),
  isWindowsReservedName: (input) => isWindowsReservedName(input),
  // filename.ts - folders
  validateFolderName: (input) => validateFolderName(input).map((issue) => issue.kind),
  isValidFolderName: (input) => isValidFolderName(input),
  hasCaseInsensitiveSiblingCollision: (input) =>
    hasCaseInsensitiveSiblingCollision(input.name, input.siblings),
  validateFolderPath: (input) => validateFolderPath(input).map((issue) => issue.kind),
  isValidFolderPath: (input) => isValidFolderPath(input),
  pathDepth: (input) => pathDepth(input),
  // tags.ts
  tagRegexMatches: (input) => tagRegexMatches(input),
  isValidTagName: (input) => isValidTagName(input),
  normalizeTagName: (input) => normalizeTagName(input),
  extractTags: (input) => extractTags(input),
  extractHeaderTagBlock: (input) => {
    const { tags, endOffset } = extractHeaderTagBlock(input);
    return { tags, endOffset, remainder: input.slice(endOffset) };
  },
  // preview.ts
  makePreview: (input) => makePreview(input),
  // images.ts
  isImageFilename: (input) => isImageFilename(input),
  imageExtensions: () => [...IMAGE_EXTENSIONS],
  // wikilinks.ts
  resolveWikilink: (input) => resolveWikilink(input.target, input.allIds),
  shortestUniqueSuffix: (input) => shortestUniqueSuffix(input.targetId, input.allIds),
  rewriteWikilinks: (input) => rewriteWikilinks(input.text, input.oldId, input.newId, input.allIds),
};

// --- Deterministic randomness ----------------------------------------------
//
// xorshift32 with a per-corpus fixed seed: reproducibility, while still sampling
// combination spaces too large to hand-author. A failure always replays from the
// printed input.

function xorshift32(seed) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

/** Deterministic string of `length` picks from `alphabet`. */
function sample(rng, alphabet, length) {
  let out = '';
  for (let index = 0; index < length; index += 1) out += alphabet[rng() % alphabet.length];
  return out;
}

/** Order-preserving de-duplication. */
function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// --- Shared adversarial character sets --------------------------------------

// Whitespace-ish code points, chosen where the two languages' notions of "space"
// are most likely to part company: JS `/\s/` + `String.prototype.trim` versus
// Rust's `char::is_whitespace()` (Unicode White_Space) + the regex crate's `\s`.
// U+0085 is White_Space but NOT JS `\s`; U+FEFF is JS `\s` but NOT White_Space;
// U+200B is neither, and is in the list to prove it stays neither.
const WHITESPACE_ISH = [
  ' ', // U+0020 space
  '\t',
  '\n',
  '\r',
  '\r\n',
  '\v', // U+000B line tabulation
  '\f', // U+000C form feed
  '\u0085', // NEL - White_Space, NOT JS \s
  '\u00a0', // no-break space
  '\u1680', // ogham space mark
  '\u2000', // en quad
  '\u2003', // em space
  '\u2007', // figure space
  '\u200a', // hair space
  '\u2028', // line separator
  '\u2029', // paragraph separator
  '\u202f', // narrow no-break space
  '\u205f', // medium mathematical space
  '\u3000', // ideographic space
  '\u200b', // ZWSP - neither language calls it space
  '\ufeff', // BOM/ZWNBSP - JS \s, NOT White_Space
];

// Characters whose case mapping is not a simple ASCII flip: final sigma
// (context-dependent), sharp s (length-changing), dotted/dotless I, the Kelvin
// sign, a ligature, long s. Case folding drives sibling collisions, the
// Windows-reserved check, tag normalization, and image-extension matching.
const CASE_TRAPS = [
  'Straße',
  'STRASSE',
  'ß',
  'SS',
  'İstanbul',
  'istanbul',
  'ı',
  'I',
  'ΟΔΟΣ',
  'οδος',
  'ΑΣ',
  'ας',
  'ς',
  'σ',
  'K', // Kelvin sign
  'k',
  'ﬁ', // fi ligature
  'fi',
  'ſ', // long s
  's',
];

// Astral (surrogate-pair) and combining sequences: where "one character" means
// different things to `String.length`, `Array.from`, and Rust's `chars()`. Lone
// surrogates are deliberately absent - a Rust `&str` cannot hold one, so there is
// no answer to compare.
const PARTY = '\u{1f389}';
const FAMILY = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}';
const ASTRAL = [
  PARTY,
  FAMILY,
  '\u{1f1fa}\u{1f1f8}', // regional-indicator pair
  'é', // precomposed e-acute
  'e\u0301', // decomposed e-acute
  '\u{1f44d}\u{1f3ff}', // emoji + skin-tone modifier
];

// \u0000 here is the LOW BOUND of the ASCII range, not a stray control
// character: the test is "is every code point in 0x00-0x7f".
// eslint-disable-next-line no-control-regex
const isAscii = (value) => typeof value === 'string' && !/[^\u0000-\u007f]/u.test(value);

// --- Family: title (filename.json) -----------------------------------------

/**
 * The title corpus. The sections up to and including the fixed-seed mixtures are
 * byte-identical to the original title-only differential (same order, same seed,
 * same alphabet) so the 2,432 inputs that caught the escaped-C1 divergence keep
 * catching it; everything after that is additive.
 */
function titleCorpus() {
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
function folderPathCorpus() {
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
function collisionCorpus() {
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

// --- Family: tags (tags.json) ----------------------------------------------

function tagContentCorpus() {
  const names = [
    'a',
    'A',
    'tag',
    'Tag',
    'TAG',
    'a1',
    'a-b',
    'a_b',
    '1a',
    '-a',
    '_a',
    'x'.repeat(49),
    'x'.repeat(50),
    'x'.repeat(51),
    'é',
    'aé',
  ];
  const terminators = [
    '.',
    ',',
    ';',
    ':',
    '!',
    '?',
    ')',
    '}',
    ']',
    '(',
    '{',
    '[',
    '#',
    '-',
    '_',
    'a',
    '/',
    PARTY,
    'é',
    '',
  ];
  const content = [];

  // Left boundary: every whitespace-ish separator in front of a tag.
  for (const ws of WHITESPACE_ISH) {
    for (const name of names) content.push(`pre${ws}#${name} post`);
    content.push(`${ws}#tag`, `#tag${ws}`, `${ws}#tag${ws}`, `a${ws}b #tag`);
  }
  // Right boundary: every terminator (and non-terminator) after a tag.
  for (const terminator of terminators) {
    content.push(`x #tag${terminator}`, `x #tag${terminator} y`, `#tag${terminator}#other`);
  }
  // Fences: marker char/length, indentation, info strings, nesting, unclosed,
  // CRLF, EOF. `stripCodeRegions` is the most structural rule in the set.
  content.push(
    '#a\n```\n#hidden\n```\n#b',
    '#a\n~~~\n#hidden\n~~~\n#b',
    '#a\n````\n#hidden\n```\nstill hidden\n````\n#b',
    '#a\n```rust\nlet x = "#nope";\n```\n#b',
    '#a\n   ```\n#hidden\n   ```\n#b',
    '#a\n    ```\n#not-a-fence\n    ```\n#b',
    '#a\n```\n~~~\n#hidden\n~~~\n```\n#after',
    '#before\n````\n#hidden\nstill hidden',
    '#a\r\n```\r\n#hidden\r\n```\r\n#b',
    '#a\n```',
    '```\n#hidden',
    '#a\n``` closing info is not blank\n#b\n```\n#c',
    'text `#notatag` and #yestag',
    'text ``#notatag`` and #yestag',
    'text ```#notatag``` and #yestag',
    'unclosed ` #maybe',
    '`` #a `` #b',
    '#a `#b` #c `#d',
    '#one #two #three #one #two',
    '#Recipe #recipe #RECIPE',
    '',
    '#',
    '##',
    '#a#b',
    '# heading\n## heading2\n\n#tag',
    'example.com#section foo#bar',
    `#tag${PARTY} but #clean works`,
  );
  // Header tag blocks: multi-line runs, blank-line terminators, trailing
  // whitespace, blocks that run to EOF, near-miss lines.
  content.push(
    '#recipes #cooking\n#healthy\n\nThis is the note content',
    'This is a note\n#inline-tag',
    '#recipes some text\nMore content',
    '#tag\n\nContent here',
    '#only-tags\n#here',
    '#Tag #tag\n\nContent',
    '#a #b\n#c\n#d\n\nContent',
    '#a\t \n\ncontent',
    '#a\r\n#b\r\n\r\ncontent',
    '#a\n   \ncontent',
    '#a\n\t\ncontent',
    '#a\n\u00a0\ncontent',
    '#a\n\u0085\ncontent',
    '#a\nplain text\n#b',
    '   #a   \n\nbody',
    `#${'x'.repeat(51)}\n\nbody`,
    '#a #b',
    '\n#a',
  );
  // Deterministic mixtures over the structural alphabet.
  const alphabet = [
    '#',
    'a',
    'b',
    'Z',
    '1',
    '-',
    '_',
    ' ',
    '\t',
    '\n',
    '\r\n',
    '`',
    '~',
    '.',
    ',',
    ')',
    ']',
    '\u00a0',
    '\u0085',
    '\ufeff',
    PARTY,
    'é',
  ];
  const rng = xorshift32(0x7a67c0de);
  for (let index = 0; index < 500; index += 1) content.push(sample(rng, alphabet, rng() % 81));
  return unique(content);
}

function tagNameCorpus() {
  const names = [
    '',
    'a',
    'A',
    'z',
    'Z',
    '0',
    '1a',
    'a1',
    '_',
    '-',
    'a_b',
    'a-b',
    'a b',
    ' a',
    'a ',
    'x'.repeat(49),
    'x'.repeat(50),
    'x'.repeat(51),
    PARTY.repeat(25),
    PARTY.repeat(26),
    'é',
    'aé',
    'Ω',
    ...CASE_TRAPS,
    ...WHITESPACE_ISH.map((ws) => `a${ws}b`),
    ...WHITESPACE_ISH.map((ws) => `${ws}tag${ws}`),
    ...WHITESPACE_ISH.map((ws) => `a${ws}${ws}b`),
    '#tag',
    '##tag',
    '#  Dog   Problems  ',
    '# #a #b',
    'Dog Problems',
    'dog\tproblems',
    'dog\n\nproblems',
  ];
  const alphabet = ['a', 'B', '1', '_', '-', ' ', '#', '\t', '\u00a0', '\u0085', '\ufeff', 'é'];
  const rng = xorshift32(0x1a67ba5e);
  for (let index = 0; index < 200; index += 1) names.push(sample(rng, alphabet, rng() % 17));
  return unique(names);
}

// --- Family: image (image.json) --------------------------------------------

function imageFilenameCorpus() {
  const filenames = [];
  for (const extension of IMAGE_EXTENSIONS) {
    filenames.push(
      `photo.${extension}`,
      `photo.${extension.toUpperCase()}`,
      `photo.${extension[0].toUpperCase()}${extension.slice(1)}`,
      `photo.${extension} `,
      `photo.${extension}\n`,
      `photo.x.${extension}`,
      `photo.${extension}.md`,
      `.${extension}`,
      `${extension}`,
      `photo.${extension}${extension}`,
    );
  }
  filenames.push(
    'note.md',
    'file.txt',
    'script.js',
    'archive.zip',
    'scan.tiff',
    'scan.tif',
    'photo.heif',
    'noextension',
    '.hidden',
    '',
    '.',
    '..',
    'trailing.',
    'a..png',
    'a.PNG.',
    '1742345678901-xk7.png',
    'ünïcode.PNG',
    `${PARTY}.jpg`,
    // Case-mapping traps in the extension slot: only a plain Unicode lowercase can
    // match, so the ligature / dotted-I / long-s / Kelvin forms must all miss.
    'photo.ſVG',
    'photo.K',
    'photo.İCO',
    'photo.ıco',
    'photo.ICO',
    `photo.${'x'.repeat(300)}`,
    'photo/with.png',
    'photo\\with.png',
  );
  const alphabet = ['a', 'P', 'N', 'G', '.', 'j', 'p', 'g', '/', ' ', 'É', PARTY];
  const rng = xorshift32(0x1a6e1701);
  for (let index = 0; index < 200; index += 1) filenames.push(sample(rng, alphabet, rng() % 13));
  return unique(filenames);
}

// --- Family: preview (preview.json) ----------------------------------------

function previewCorpus() {
  const contents = [
    '',
    'Just a normal note line',
    'line one\nline two\nline three',
    'col1\tcol2\tcol3',
    'windows line one\r\nwindows line two',
    'a\r\nb\nc\td',
    'bare\rcarriage\rreturns',
    'mixed\r\r\n\n\r',
    '   padded content here   ',
    '\n\nactual content after blanks',
    '   \n\t  ',
    'café résumé naïve — accents and an em dash',
    'Ωμέγα Ελληνικά',
    `  ${PARTY}\tparty\nover here  `,
  ];
  // Truncation boundary, counted in code points on both sides.
  for (const length of [99, 100, 101]) {
    contents.push('A'.repeat(length));
    contents.push(PARTY.repeat(length));
    contents.push(`${'a'.repeat(length - 1)}${PARTY}tail`);
    contents.push(`${'a'.repeat(length - 1)}étail`);
    contents.push(`${FAMILY.repeat(4)}${'a'.repeat(length)}`);
  }
  // Collapse-then-trim ordering: whitespace inside the first 100 code points
  // changes what survives truncation.
  contents.push(`${'A'.repeat(60)}\n${'B'.repeat(60)}`);
  contents.push(`${'A'.repeat(99)}\n${'B'.repeat(99)}`);
  contents.push(`\t${'A'.repeat(100)}\t`);
  for (const ws of WHITESPACE_ISH) {
    contents.push(`${ws}content${ws}`, `a${ws}b`, ws, `${ws}${ws}`);
  }
  for (const astral of ASTRAL) {
    contents.push(astral.repeat(60), ` ${astral} \n ${astral} `);
  }
  // Image constructs are stood in as the placeholder BEFORE collapse/trim/
  // truncate, so both languages must agree on where a construct starts and ends
  // (including the malformed ones that are not constructs at all) and on
  // spending two code points of the budget per placeholder.
  contents.push(
    '![](image-20260814-130425.png)',
    '![](image-20260814-130425.png)\ntext below',
    '![alt text](photo.png)',
    'lead ![](a.png) trail',
    '![](a.png)![](b.png)![](c.png)',
    '![](a.png)\n\n# Heading\ntext',
    '- ![](a.png) caption',
    '> ![](a.png)',
    'a [link](https://example.com) is not an image',
    '![unterminated](a.png',
    '![no target] here',
    '![a]b](x.png)',
    '![a![b](c.png)',
    '!![](x.png)',
    '![](a(b)c.png)',
    '![](){}',
    '![]()',
    '![\n](a.png)',
    `![](${PARTY}.png)`,
    `![${PARTY}](a.png)`,
    // Placeholder straddling the 100-code-point truncation boundary: the
    // variation selector must be dropped or kept identically on both sides.
    `${'a'.repeat(99)}![](x.png)tail`,
    `${'a'.repeat(98)}![](x.png)tail`,
    `${'a'.repeat(100)}![](x.png)`,
    `${'![](a.png)'.repeat(60)}`,
  );
  const alphabet = [
    'a',
    'B',
    ' ',
    '\t',
    '\n',
    '\r',
    '\r\n',
    '\u00a0',
    '\u0085',
    '\ufeff',
    PARTY,
    'é',
  ];
  const rng = xorshift32(0x9e3779b9);
  for (let index = 0; index < 300; index += 1) contents.push(sample(rng, alphabet, rng() % 130));
  // Random image-ish soup: the delimiter characters interleaved with text and
  // whitespace, so nesting/overlap cases nobody hand-wrote still get compared.
  const imageAlphabet = ['!', '[', ']', '(', ')', 'a', '.', 'png', ' ', '\n', PARTY];
  for (let index = 0; index < 400; index += 1)
    contents.push(sample(rng, imageAlphabet, rng() % 40));
  return unique(contents);
}

// --- Family: wikilinks (wikilinks.json) ------------------------------------

// Curated id universe: nested folders, leaves that collide at one and at two
// components, unicode + emoji ids, a deep path for suffix resolution, NFC/NFD
// twins that must stay distinct, and a case-only pair (link resolution is
// case-SENSITIVE, unlike sibling collision).
const WIKI_IDS = [
  'grocery list',
  'notes',
  'Projects/notes',
  'Specs/folder-support',
  'Specs/Drafts/folder-support',
  'Recipes/pasta',
  'Recipes/Dinner/pasta',
  'Journal/2026/June/pasta night',
  'Unicode/café résumé',
  'Unicode/cafe\u0301 re\u0301sume\u0301',
  `Emoji/${PARTY} party`,
  'Deep/a/b/c/leaf',
  'Case/Notes',
  'Case/notes',
];

// Resolution and suffix shortening are both functions of the WHOLE id universe,
// so one universe probes exactly one shape of ambiguity. These are the shapes
// that matter: total collision at every suffix length, a chain where each id is a
// suffix of the next, duplicates, degenerate ids, deep paths, unicode-only.
const WIKI_UNIVERSES = [
  WIKI_IDS,
  // Every leaf collides; disambiguation has to climb.
  ['a/x', 'b/x', 'c/b/x', 'd/c/b/x', 'x'],
  // Suffix chain: 'x' is a suffix of 'b/x' is a suffix of 'a/b/x'.
  ['x', 'b/x', 'a/b/x'],
  // Duplicates, which the suffix rule must exclude when comparing against self.
  ['dup/x', 'dup/x', 'other/x'],
  // Degenerate ids: empty components, leading/trailing slashes, a bare slash.
  ['', '/', '//', 'a//b', '/leading', 'trailing/', 'a'],
  // Deep, and unicode-only with NFC/NFD twins.
  ['Deep/a/b/c/d/e/f/leaf', 'a/b/c/d/e/f/leaf', 'leaf'],
  ['café', 'cafe\u0301', 'x/café', 'x/cafe\u0301'],
  [],
];

// Targets every universe is asked about, whether or not they appear in it.
const WIKI_ADVERSARIAL_TARGETS = [
  '',
  '/',
  '//',
  '/pasta',
  'pasta/',
  'a//b',
  'missing',
  'Nope/pasta',
  'Specs/folder-support|alias',
  `${PARTY} party`,
  'café résumé',
  'cafe\u0301 re\u0301sume\u0301',
  'NOTES',
  'notes ',
  ' notes',
  'Deep/a/b/c/leaf/extra',
  'b/c/leaf',
  'leaf',
  'x',
  'x'.repeat(300),
];

/** Every id, every path suffix AND prefix of it, plus the adversarial targets. */
function wikilinkTargetCorpus() {
  const cases = [];
  for (const allIds of WIKI_UNIVERSES) {
    const targets = [...allIds, ...WIKI_ADVERSARIAL_TARGETS];
    for (const id of allIds) {
      const parts = id.split('/');
      // Suffixes must resolve when unique; prefixes must never resolve by
      // accident. Probing both pins the direction of the tail match.
      for (let index = 0; index < parts.length; index += 1) {
        targets.push(parts.slice(index).join('/'));
        targets.push(parts.slice(0, index + 1).join('/'));
      }
    }
    for (const target of unique(targets)) cases.push({ target, allIds });
  }
  return cases;
}

/** Shortest unique suffix for every id in every universe, plus outsiders. */
function suffixCorpus() {
  const outsiders = ['Brand/new note', '', '/', 'a//b', 'Case/NOTES', 'leaf', 'x', 'a/x'];
  const cases = [];
  for (const allIds of WIKI_UNIVERSES) {
    for (const targetId of unique([...allIds, ...outsiders])) cases.push({ targetId, allIds });
  }
  return cases;
}

function rewriteCorpus() {
  const templates = [
    'See [[TARGET]] for details',
    'twice [[TARGET]] and [[TARGET]]',
    'adjacent [[TARGET]][[TARGET]]',
    'alias [[TARGET|the spec]]',
    'nested weird [[a[[TARGET]] end',
    'extra bracket [[TARGET]]] tail',
    'newline [[TAR\nGET]]',
    'empty [[]] and [[TARGET]]',
    'bar only [[|]] then [[TARGET]]',
    '```\n[[TARGET]]\n```',
    'inline `[[TARGET]]` code',
    'plain text, no links',
    '[[TARGET',
    'TARGET]]',
    '[[[TARGET]]]',
    '[[ TARGET ]]',
    'unicode voir [[TARGET]] !',
  ];
  const renames = [
    {
      oldId: 'Specs/folder-support',
      newId: 'Specs/folder-support-v2',
      target: 'Specs/folder-support',
    },
    { oldId: 'grocery list', newId: 'Lists/grocery list', target: 'grocery list' },
    { oldId: 'Recipes/pasta', newId: 'Recipes/spaghetti', target: 'pasta' },
    { oldId: 'Recipes/Dinner/pasta', newId: 'Recipes/Dinner/lasagna', target: 'Dinner/pasta' },
    { oldId: 'Projects/notes', newId: 'Projects/notes-v2', target: 'notes' },
    {
      oldId: 'Unicode/café résumé',
      newId: 'Unicode/CV',
      target: 'café résumé',
    },
    { oldId: `Emoji/${PARTY} party`, newId: 'Emoji/fiesta', target: `${PARTY} party` },
    { oldId: 'notes', newId: 'notes', target: 'notes' },
    { oldId: 'Deep/a/b/c/leaf', newId: 'Deep/a/b/c/leaf-2', target: 'b/c/leaf' },
    { oldId: 'missing', newId: 'found', target: 'missing' },
    { oldId: '', newId: 'x', target: '' },
  ];
  const cases = [];
  for (const template of templates) {
    for (const rename of renames) {
      cases.push({
        text: template.replaceAll('TARGET', rename.target),
        oldId: rename.oldId,
        newId: rename.newId,
        allIds: WIKI_IDS,
      });
    }
  }
  // The legacy-bare-link case: the id universe is POST-rename, so resolution has
  // to re-admit oldId for the bare leaf to still resolve.
  cases.push({
    text: 'buy [[grocery list]] and again [[grocery list]]',
    oldId: 'grocery list',
    newId: 'Lists/grocery list',
    allIds: ['Lists/grocery list', ...WIKI_IDS.filter((id) => id !== 'grocery list')],
  });
  const alphabet = ['[', ']', '|', 'a', 'notes', 'pasta', ' ', '\n', '/', PARTY];
  const rng = xorshift32(0x571c0de5);
  for (let index = 0; index < 300; index += 1) {
    cases.push({
      text: sample(rng, alphabet, rng() % 25),
      oldId: WIKI_IDS[rng() % WIKI_IDS.length],
      newId: 'Renamed/target',
      allIds: WIKI_IDS,
    });
  }
  return cases;
}

// --- Family table -----------------------------------------------------------
//
// Adding a family: add an entry whose `probes()` yields `{ op, input }` for every
// op the family's fixture uses, then add each op to `TS_OPS` and to the Rust
// dispatcher. The coverage guard tells you if you missed one.

const FAMILIES = [
  {
    name: 'title',
    fixture: 'filename',
    probes() {
      const titles = titleCorpus();
      const out = [];
      for (const op of [
        'sanitizeTitle',
        'validateTitle',
        'isValidTitle',
        'isWindowsReservedName',
        'validateFolderName',
        'isValidFolderName',
      ]) {
        for (const title of titles) out.push({ op, input: title });
      }
      for (const relPath of folderPathCorpus()) {
        out.push({ op: 'validateFolderPath', input: relPath });
        out.push({ op: 'isValidFolderPath', input: relPath });
        out.push({ op: 'pathDepth', input: relPath });
      }
      for (const input of collisionCorpus()) {
        out.push({ op: 'hasCaseInsensitiveSiblingCollision', input });
      }
      return out;
    },
  },
  {
    name: 'tags',
    fixture: 'tags',
    probes() {
      const out = [];
      for (const content of tagContentCorpus()) {
        out.push({ op: 'tagRegexMatches', input: content });
        out.push({ op: 'extractTags', input: content });
        out.push({ op: 'extractHeaderTagBlock', input: content });
      }
      for (const name of tagNameCorpus()) {
        out.push({ op: 'isValidTagName', input: name });
        out.push({ op: 'normalizeTagName', input: name });
      }
      return out;
    },
  },
  {
    name: 'image',
    fixture: 'image',
    probes() {
      const out = imageFilenameCorpus().map((filename) => ({
        op: 'isImageFilename',
        input: filename,
      }));
      out.push({ op: 'imageExtensions', input: null });
      return out;
    },
  },
  {
    name: 'preview',
    fixture: 'preview',
    probes() {
      return previewCorpus().map((content) => ({ op: 'makePreview', input: content }));
    },
  },
  {
    name: 'wikilinks',
    fixture: 'wikilinks',
    probes() {
      return [
        ...wikilinkTargetCorpus().map((input) => ({ op: 'resolveWikilink', input })),
        ...suffixCorpus().map((input) => ({ op: 'shortestUniqueSuffix', input })),
        ...rewriteCorpus().map((input) => ({ op: 'rewriteWikilinks', input })),
      ];
    },
  },
];

// Conformance corpora this differential deliberately does NOT drive, each with
// the reason. The coverage guard fails on any corpus that is neither driven nor
// listed here, so a new one cannot quietly arrive without a decision.
const FIXTURES_OUTSIDE_THE_DIFFERENTIAL = {
  'server-url.json':
    'validateServerUrl has NO Rust implementation: the rule is hand-written three ' +
    'times, in TS, Swift, and Kotlin (scripts/drift-registry.json concept ' +
    '"validate-server-url"), and each shell asserts this fixture from its own unit ' +
    'test. With no second implementation reachable from Node there is nothing to ' +
    'differentiate against - the fixture IS the lock. Growing it also means bumping ' +
    'the case count asserted in apps/android/.../SyncManagerDefaultsTest.kt and ' +
    're-running both native suites.',
  'path-safety.json':
    'ensureSafeNoteId (TS) <-> safe_note_path (Rust) is a filesystem-path rule, not a ' +
    'note rule: the Rust side takes a vault root and returns a resolved path, so it is ' +
    'not answerable through the pure futo-notes-model oracle. Locked by this fixture ' +
    'plus src/lib/platform/pathSafety.test.ts and ' +
    'crates/futo-notes-core/tests/path_safety_conformance.rs.',
  'constants.json':
    'Shared scalar constants, not ops. Locked by crates/futo-notes-model/tests/' +
    'conformance.rs, src/lib/constantsConformance.test.ts, and the Tauri watcher test.',
};

// Divergences the two languages KNOWN-ship today. Each entry names the exact op
// set and input class it excuses, and why. Every run prints how many probes each
// entry suppressed, so an exclusion that outlived its cause shows up as a count
// that should have reached zero - fix the cause, then delete the entry.
//
// An entry is a decision to SHIP a divergence. Keep the input class as narrow as
// the CAUSE, never as wide as the symptom, and file the follow-up.
const KNOWN_DIVERGENCES = [
  {
    id: 'js-\\s-versus-unicode-white_space',
    // Found by this differential the first time it reached past the title family.
    why:
      'The two languages disagree about exactly two code points, in opposite ' +
      "directions. U+0085 (NEL) has the Unicode White_Space property, so Rust's " +
      "char::is_whitespace() and the regex crate's \\s accept it while JS /\\s/ and " +
      'String.prototype.trim() do not. U+FEFF (BOM/ZWNBSP) is the mirror image: JS ' +
      '\\s and trim() treat it as space, Unicode White_Space does not. Every rule ' +
      'that asks "is this whitespace?" therefore parts company on those two ' +
      'characters and only those two: tag left/right boundaries, the header ' +
      'tag-block line test, tag-name normalization, and the preview trim. The ' +
      'reviewed goldens are ASCII, so they never saw it. Rust is canonical (M6), so ' +
      'closing this means teaching the TypeScript copies Unicode White_Space ' +
      '(/\\p{White_Space}/u plus a matching trim) - a real behavior change on a ' +
      'per-keystroke path, so it wants its own MR and a docs/spec line. The ' +
      'realistic case is a BOM-prefixed note from a Windows editor: its sidebar ' +
      'preview and its tag set differ depending on which side computed them.',
    ops: new Set([
      'tagRegexMatches',
      'extractTags',
      'extractHeaderTagBlock',
      'normalizeTagName',
      'makePreview',
    ]),
    matches: (input) => typeof input === 'string' && /[\u0085\ufeff]/u.test(input),
  },
];

// --- Comparison -------------------------------------------------------------

/**
 * JSON, with every character outside printable ASCII escaped. `JSON.stringify`
 * alone leaves U+0085, U+00A0, U+200B, and U+FEFF as invisible bytes in the
 * failure report - and those are exactly the inputs this differential exists to
 * catch, so an unreadable report is a useless one.
 */
function describe(value) {
  return JSON.stringify(value).replace(/[^ -~]/gu, (char) =>
    char.codePointAt(0) > 0xffff
      ? `\\u{${char.codePointAt(0).toString(16)}}`
      : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Structural JSON equality via canonical (key-sorted) serialization. */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Drop fields whose *representation* legitimately differs between the two
 * languages. `extractHeaderTagBlock`'s `endOffset` is a UTF-8 byte offset in Rust
 * and a UTF-16 code-unit offset in TypeScript: each is correct for its own string
 * type, and they only coincide for ASCII. The representation-independent
 * `remainder` is compared for EVERY input, so the block boundary itself stays
 * fully locked.
 */
function comparable(op, input, answer) {
  if (op === 'extractHeaderTagBlock' && !isAscii(input)) {
    const { endOffset: _byteVersusUtf16, ...rest } = answer;
    return rest;
  }
  return answer;
}

// --- Coverage guard ---------------------------------------------------------

function assertEveryFixtureOpIsCovered(probedOps) {
  const problems = [];
  const files = readdirSync(HERE)
    .filter((name) => name.endsWith('.json'))
    .sort();

  const fixtureOps = new Map(); // op -> the fixture file that exercises it
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(path.join(HERE, file), 'utf8'));
    if (!Array.isArray(fixture.groups)) {
      if (!(file in FIXTURES_OUTSIDE_THE_DIFFERENTIAL)) {
        problems.push(
          `${file} is a conformance corpus this differential neither drives nor ` +
            'excludes. Either give its ops a family in FAMILIES, or add it to ' +
            'FIXTURES_OUTSIDE_THE_DIFFERENTIAL with the reason it cannot be driven.',
        );
      }
      continue;
    }
    for (const group of fixture.groups) fixtureOps.set(group.op, file);
  }

  for (const [op, file] of fixtureOps) {
    if (probedOps.has(op)) continue;
    problems.push(
      `op "${op}" is exercised by ${file} but never probed by this differential - the ` +
        'hand-reviewed goldens would be the only thing holding the two languages ' +
        'together. Add it to the owning family in FAMILIES.',
    );
  }
  for (const op of probedOps) {
    if (!(op in TS_OPS)) problems.push(`op "${op}" is probed but has no TS_OPS entry.`);
  }

  if (problems.length > 0) {
    process.stderr.write(
      `Rule-differential coverage guard failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exit(1);
  }
}

// --- Run --------------------------------------------------------------------

const selected = process.argv
  .filter((arg) => arg.startsWith('--family='))
  .map((arg) => arg.slice('--family='.length));
const families = selected.length
  ? FAMILIES.filter((family) => selected.includes(family.name))
  : FAMILIES;
if (selected.length > 0 && families.length !== new Set(selected).size) {
  process.stderr.write(
    `Unknown --family. Known families: ${FAMILIES.map((family) => family.name).join(', ')}\n`,
  );
  process.exit(1);
}

const probes = [];
for (const family of families) {
  for (const probe of family.probes()) probes.push({ family: family.name, ...probe });
}
// Only a full run can judge coverage: a narrowed --family run drives some ops on
// purpose, so "an op no family probes" there is the flag, not a finding.
if (selected.length === 0) {
  assertEveryFixtureOpIsCovered(new Set(probes.map((probe) => probe.op)));
}

const rust = spawnSync(
  'cargo',
  ['run', '--quiet', '-p', 'futo-notes-model', '--example', 'title_rule_oracle'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(probes.map(({ op, input }) => ({ op, input }))),
    maxBuffer: 512 * 1024 * 1024,
  },
);
if (rust.status !== 0) {
  process.stderr.write(rust.stderr || '');
  process.stderr.write(`\nThe Rust rule oracle exited ${rust.status}. Nothing was compared.\n`);
  process.exit(rust.status ?? 1);
}

const rustAnswers = JSON.parse(rust.stdout);
if (rustAnswers.length !== probes.length) {
  process.stderr.write(
    `Oracle returned ${rustAnswers.length} answers for ${probes.length} probes.\n`,
  );
  process.exit(1);
}

const suppressed = new Map(KNOWN_DIVERGENCES.map((divergence) => [divergence.id, 0]));
const mismatches = [];
const perFamily = new Map();

for (let index = 0; index < probes.length; index += 1) {
  const probe = probes[index];
  const counts = perFamily.get(probe.family) ?? { probes: 0, ops: new Set() };
  counts.probes += 1;
  counts.ops.add(probe.op);
  perFamily.set(probe.family, counts);

  const typescript = comparable(probe.op, probe.input, TS_OPS[probe.op](probe.input));
  const rustAnswer = comparable(probe.op, probe.input, rustAnswers[index]);
  if (canon(typescript) === canon(rustAnswer)) continue;

  const excuse = KNOWN_DIVERGENCES.find(
    (divergence) => divergence.ops.has(probe.op) && divergence.matches(probe.input),
  );
  if (excuse) {
    suppressed.set(excuse.id, suppressed.get(excuse.id) + 1);
    continue;
  }
  mismatches.push({ ...probe, typescript, rust: rustAnswer });
}

if (mismatches.length > 0) {
  const shown = process.argv.includes('--all') ? mismatches : mismatches.slice(0, 25);
  const byOp = new Map();
  for (const mismatch of mismatches) {
    const key = `${mismatch.family}/${mismatch.op}`;
    byOp.set(key, (byOp.get(key) ?? 0) + 1);
  }
  process.stderr.write(
    '\nRULE DIFFERENTIAL FAILED - the TypeScript and Rust note rules disagree on ' +
      `${mismatches.length} of ${probes.length} probes.\n\n` +
      'Disagreements by rule:\n' +
      [...byOp.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `  ${String(count).padStart(6)}  ${key}\n`)
        .join('') +
      '\n' +
      shown
        .map(
          (mismatch, position) =>
            `[${position + 1}] family=${mismatch.family} op=${mismatch.op}\n` +
            `    input:      ${describe(mismatch.input)}\n` +
            `    typescript: ${describe(mismatch.typescript)}\n` +
            `    rust:       ${describe(mismatch.rust)}\n`,
        )
        .join('\n') +
      (mismatches.length > shown.length
        ? `\n... and ${mismatches.length - shown.length} more (re-run with --all).\n`
        : '') +
      '\nRust is canonical (AGENTS.md M6/M7). Fix the TypeScript copy under\n' +
      'packages/editor/src/ (or src/shared/note/wikilinks.ts) unless the Rust rule is\n' +
      'the one that is wrong - then change BOTH, update the reviewed goldens in\n' +
      'tests/conformance/*.json, and record the behavior change in docs/spec/.\n' +
      'See tests/conformance/README.md.\n',
  );
  process.exit(1);
}

const compared = probes.length;
const summary = [...perFamily.entries()]
  .map(
    ([name, counts]) =>
      `  ${name.padEnd(10)} ${String(counts.probes).padStart(6)} probes over ` +
      `${counts.ops.size} ops`,
  )
  .join('\n');
// The suppressed counts print on a GREEN run on purpose: a divergence nobody sees
// in the output is a divergence nobody fixes.
const excuses = [...suppressed.entries()]
  .map(([id, count]) => `  ${String(count).padStart(6)} suppressed by KNOWN_DIVERGENCES "${id}"`)
  .join('\n');
process.stdout.write(
  `Rule differential OK - TypeScript and Rust agree on ${compared} probes across ` +
    `${families.length} famil${families.length === 1 ? 'y' : 'ies'}:\n${summary}\n` +
    (excuses ? `${excuses}\n` : '') +
    (selected.length > 0 ? 'PARTIAL RUN - coverage guard skipped (--family given).\n' : ''),
);
