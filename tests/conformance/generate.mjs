// Conformance fixture generator.
//
// Produces the language-neutral golden fixtures in tests/conformance/*.json
// that pin the deterministic note rules (filename/title, tags, image). The
// *inputs* are drawn from the co-located editor rule tests; the
// *expected* outputs are computed by running the canonical TypeScript
// implementation, so the fixtures are guaranteed to encode TS behavior
// exactly. Both Vitest (packages/editor/src/conformance.test.ts) and Rust
// (crates/futo-notes-model/tests/conformance.rs) read these fixtures, so a
// rule that drifts in any one language fails the other's conformance test.
//
//   pnpm exec tsx tests/conformance/generate.mjs         # regenerate fixtures
//   pnpm exec tsx tests/conformance/generate.mjs --check # fail if stale (CI)
//
// Re-run after any change to filename.ts / tags.ts / images.ts. The contract
// "operations" below are the language-neutral verbs each binding implements.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  TAG_REGEX,
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

const HERE = dirname(fileURLToPath(import.meta.url));

// validateTitle/validateFolderName/validateFolderPath return rich issue
// objects; the cross-language contract is the ordered list of issue *kinds*.
const kinds = (issues) => issues.map((i) => i.kind);

// Raw TAG_REGEX behavior: the ordered capture-group-1 values (with the dupes
// the regex itself yields, before extractTags dedups/normalizes).
function tagRegexMatches(content) {
  const re = new RegExp(TAG_REGEX.source, TAG_REGEX.flags);
  const out = [];
  let m;
  while ((m = re.exec(content)) !== null) out.push(m[1]);
  return out;
}

// extractHeaderTagBlock returns a JS (UTF-16) offset. The cross-language
// contract carries both `endOffset` (meaningful + identical for ASCII, which
// every fixture input is) and the representation-independent `remainder` =
// content.slice(endOffset). Rust compares the remainder; the byte offset is
// validated separately for ASCII inputs.
function headerTagBlock(content) {
  const { tags, endOffset } = extractHeaderTagBlock(content);
  return { tags, endOffset, remainder: content.slice(endOffset) };
}

const ALPHA_300 = 'a'.repeat(300);
const ALPHA_201 = 'a'.repeat(201);
const ALPHA_51 = 'a'.repeat(51);
const TOO_DEEP = Array.from({ length: 11 }, (_, i) => `f${i}`).join('/');

// Each group: { op, fn, cases: [{ input, expected }] }. `op` is the
// language-neutral verb the Rust/Swift/TS binding dispatches on; `fn` names
// the TS function for provenance.
function group(op, fn, fnImpl, inputs) {
  return { op, fn, cases: inputs.map((input) => ({ input, expected: fnImpl(input) })) };
}

const filename = {
  description: 'Filename / title sanitization + validation rules (filename.ts).',
  groups: [
    group('sanitizeTitle', 'sanitizeTitle', sanitizeTitle, [
      'hello-world',
      'a<b>c:d',
      'a<b>c:d"e|f?g*h',
      '..hidden',
      'file..',
      'v2.0 notes',
      'Dr. Smith',
      '...',
      '.',
      ALPHA_300,
      '',
      '   ',
      'a\x00b\x1fc',
      'a\x7fb',
      '  hello  ',
      // D4/B2b: Windows-reserved de-reservation + leading/trailing-dot strip.
      'CON',
      'con',
      'CON.bak',
      'NUL.txt',
      'CONSOLE',
      '.env',
      'note .',
    ]),
    group('validateTitle', 'validateTitle', (s) => kinds(validateTitle(s)), [
      'my note',
      'a<b',
      '.hidden',
      'file.',
      ALPHA_201,
      '',
      '   ',
      '.<bad>.',
      'v2.0 notes',
      'Dr. Smith',
      'a\x7fb',
    ]),
    group('isValidTitle', 'isValidTitle', isValidTitle, ['my note', '.hidden', 'a<b', '']),
    group('isWindowsReservedName', 'isWindowsReservedName', isWindowsReservedName, [
      'CON',
      'con',
      'Con',
      'PRN',
      'prn',
      'AUX',
      'NUL',
      'COM1',
      'COM2',
      'COM3',
      'COM4',
      'COM5',
      'COM6',
      'COM7',
      'COM8',
      'COM9',
      'lpt1',
      'lpt2',
      'lpt3',
      'lpt4',
      'lpt5',
      'lpt6',
      'lpt7',
      'lpt8',
      'lpt9',
      'CON.md',
      'lpt5.txt',
      'COM10',
      'hello',
      'confidential',
    ]),
    group('validateFolderName', 'validateFolderName', (s) => kinds(validateFolderName(s)), [
      'Specs',
      'CON',
      '.hidden',
      'a/b',
      'a\\b',
      'a:b',
      '',
    ]),
    group('isValidFolderName', 'isValidFolderName', isValidFolderName, ['Specs', 'CON', 'lpt9']),
    {
      op: 'hasCaseInsensitiveSiblingCollision',
      fn: 'hasCaseInsensitiveSiblingCollision',
      cases: [
        { input: { name: 'Specs', siblings: ['specs'] } },
        { input: { name: 'SPECS', siblings: ['Specs'] } },
        { input: { name: 'Specs', siblings: ['Other', 'Notes'] } },
        { input: { name: 'Specs', siblings: [] } },
      ].map((c) => ({
        input: c.input,
        expected: hasCaseInsensitiveSiblingCollision(c.input.name, c.input.siblings),
      })),
    },
    group('validateFolderPath', 'validateFolderPath', (s) => kinds(validateFolderPath(s)), [
      'Specs',
      'Specs/Folder',
      'a/b/c',
      TOO_DEEP,
      'CON/foo',
      'a/PRN',
      'a//b',
      'a/./b',
      'a/../b',
    ]),
    group('isValidFolderPath', 'isValidFolderPath', isValidFolderPath, [
      'Specs',
      'Specs/Folder',
      'a/b/c',
      'CON/foo',
      'a/PRN',
      'a//b',
      'a/./b',
      'a/../b',
    ]),
    group('pathDepth', 'pathDepth', pathDepth, ['foo', 'a/foo', 'a/b/c/foo']),
  ],
};

const tags = {
  description: 'Tag parsing + validation rules (tags.ts).',
  groups: [
    group('tagRegexMatches', 'TAG_REGEX', tagRegexMatches, [
      '#recipes #cooking',
      '#123 #a1 #Z',
      '#meal-prep #to_do',
      '# heading\n## heading2',
      '#tag\n#another',
      'example.com#section foo#bar',
    ]),
    group('isValidTagName', 'isValidTagName', isValidTagName, [
      'recipes',
      'meal-prep',
      'to_do',
      'a',
      '',
      '123',
      '-start',
      '_start',
      'React',
      'dog problems',
      ALPHA_51,
    ]),
    group('normalizeTagName', 'normalizeTagName', normalizeTagName, [
      'Whale',
      'dog problems',
      '#Dog   Problems',
    ]),
    group('extractTags', 'extractTags', extractTags, [
      '#recipes #cooking\n\nSome note about food.',
      'Check out this #recipe for #healthy eating.',
      '#Recipe #recipe #RECIPE',
      '#real\n\n```\n#fake\n```\n\n#also-real',
      '#real\n\n~~~\n#fake\n~~~\n\n#also-real',
      'Use `#notATag` but #realTag is fine',
      '# Heading\n## Another\n\n#tag',
      'Just some text',
      '',
      '#before\n```\n#inside',
      '#tag1, #tag2. #tag3! #tag4?',
    ]),
    group('extractHeaderTagBlock', 'extractHeaderTagBlock', headerTagBlock, [
      '#recipes #cooking\n#healthy\n\nThis is the note content',
      'This is a note\n#inline-tag',
      '#recipes some text\nMore content',
      '#tag\n\nContent here',
      '#only-tags\n#here',
      '#Tag #tag\n\nContent',
      '#a #b\n#c\n#d\n\nContent',
    ]),
  ],
};

const image = {
  description: 'Image filename detection (images.ts).',
  groups: [
    group('isImageFilename', 'isImageFilename', isImageFilename, [
      'photo.jpg',
      'photo.jpeg',
      'image.png',
      'animation.gif',
      'modern.webp',
      'vector.svg',
      'bitmap.bmp',
      'icon.ico',
      'next-gen.avif',
      'apple.heic',
      'photo.JPG',
      'photo.Png',
      'photo.WEBP',
      // D4 boundary: legacy formats dropped from the canonical set + the
      // exact-extension rule (extension is only what follows the LAST dot).
      'scan.tiff',
      'scan.tif',
      'photo.heif',
      'photo.TIFF',
      'x.tiff.md',
      'x.tiff.png',
      'note.md',
      'file.txt',
      'script.js',
      'style.css',
      'archive.zip',
      'noextension',
      '.hidden',
      '1234567890-abc.jpg',
      '1742345678901-xk7.png',
    ]),
    {
      op: 'imageExtensions',
      fn: 'IMAGE_EXTENSIONS',
      cases: [{ input: null, expected: [...IMAGE_EXTENSIONS] }],
    },
  ],
};

const preview = {
  description: 'Note list-preview rule (preview.ts ↔ Rust make_preview).',
  groups: [
    group('makePreview', 'makePreview', makePreview, [
      // normal — short content passes through unchanged
      'Just a normal note line',
      // newlines collapse to single spaces
      'line one\nline two\nline three',
      // tabs collapse to single spaces
      'col1\tcol2\tcol3',
      // CRLF collapses to ONE space (not two) — the previously-divergent case
      'windows line one\r\nwindows line two',
      // mixed CR/LF/tab
      'a\r\nb\nc\td',
      // leading + trailing whitespace is trimmed
      '   padded content here   ',
      // leading blank lines: trim happens before truncation
      '\n\nactual content after blanks',
      // whitespace-only → empty after trim
      '   \n\t  ',
      // empty
      '',
      // >100 chars truncates AFTER collapse/trim, counted in code points
      'A'.repeat(60) + '\n' + 'B'.repeat(60),
      'x'.repeat(250),
      // exactly 100 chars
      'C'.repeat(100),
      // unicode/emoji: take 100 code points, never split an astral pair
      // (Rust .chars().take(100) === Array.from(...).slice(0,100))
      '🎉'.repeat(120),
      'café résumé naïve — a note with accents and an em dash',
      'Ωμέγα Ελληνικά γράμματα',
      // emoji mixed with collapsing whitespace + trim
      `  🎉\tparty\nover here  `,
    ]),
  ],
};

// ── Wikilink rules (src/shared/note/wikilinks.ts ↔ Rust wikilinks.rs ports) ─────────
//
// Curated id universe: nested folders, ambiguous leaves (`pasta`,
// `folder-support`, `notes`), unicode + emoji ids, and a deep path for the
// suffix-resolution cases. Every expected value is computed by the canonical
// TS, so a Rust divergence fails the model crate's conformance test.
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
  'Emoji/🎉 party',
  'Deep/a/b/c/leaf',
];

const wikilinks = {
  description: 'Wikilink resolution / display-suffix / rewrite rules (wikilinks.ts).',
  groups: [
    {
      op: 'resolveWikilink',
      fn: 'resolveWikilink',
      cases: [
        'grocery list', // exact root-level id
        'Specs/folder-support', // exact full path
        'pasta night', // bare leaf, unique
        'pasta', // bare leaf, ambiguous → null
        'folder-support', // bare leaf, ambiguous → null
        'notes', // exact id wins over leaf ambiguity
        'leaf', // bare leaf, unique (deep path)
        'Dinner/pasta', // multi-component unique suffix
        'Drafts/folder-support', // multi-component unique suffix
        'b/c/leaf', // deeper unique suffix
        'June/pasta night',
        'missing', // absent → null
        'Nope/pasta', // multi-component, no tail match → null
        '', // empty → null
        'Specs/folder-support|alias', // pipe alias is PART of the target → null
        'café résumé', // unicode bare leaf
        '🎉 party', // emoji bare leaf
        '/pasta', // leading slash → empty first component → null
      ].map((target) => ({
        input: { target, allIds: WIKI_IDS },
        expected: resolveWikilink(target, WIKI_IDS),
      })),
    },
    {
      op: 'shortestUniqueSuffix',
      fn: 'shortestUniqueSuffix',
      cases: [
        { targetId: 'grocery list', allIds: WIKI_IDS }, // unique leaf
        { targetId: 'Specs/folder-support', allIds: WIKI_IDS }, // leaf collides → 2 components
        { targetId: 'Specs/Drafts/folder-support', allIds: WIKI_IDS },
        { targetId: 'Recipes/pasta', allIds: WIKI_IDS },
        { targetId: 'Recipes/Dinner/pasta', allIds: WIKI_IDS },
        { targetId: 'Journal/2026/June/pasta night', allIds: WIKI_IDS },
        { targetId: 'notes', allIds: WIKI_IDS }, // no unique suffix exists → full id
        { targetId: 'Projects/notes', allIds: WIKI_IDS },
        { targetId: 'Emoji/🎉 party', allIds: WIKI_IDS },
        { targetId: 'Brand/new note', allIds: WIKI_IDS }, // target not in universe
        { targetId: 'a/x', allIds: ['a/x', 'b/a/x'] }, // total collision → full id
        { targetId: 'dup/x', allIds: ['dup/x', 'dup/x'] }, // duplicates excluded → leaf
      ].map(({ targetId, allIds }) => ({
        input: { targetId, allIds },
        expected: shortestUniqueSuffix(targetId, allIds),
      })),
    },
    {
      op: 'rewriteWikilinks',
      fn: 'rewriteWikilinks',
      cases: [
        // Full-path link, single rewrite.
        {
          text: 'See [[Specs/folder-support]] for details',
          oldId: 'Specs/folder-support',
          newId: 'Specs/folder-support-v2',
          allIds: WIKI_IDS,
        },
        // Legacy bare link against the POST-rename universe — the resolution
        // ctx re-includes oldId, so the bare leaf still resolves.
        {
          text: 'buy [[grocery list]] and again [[grocery list]]',
          oldId: 'grocery list',
          newId: 'Lists/grocery list',
          allIds: ['Lists/grocery list', ...WIKI_IDS.filter((id) => id !== 'grocery list')],
        },
        // Pipe alias is part of the target per WIKILINK_RE → unresolvable → kept.
        {
          text: 'see [[Specs/folder-support|the spec]]',
          oldId: 'Specs/folder-support',
          newId: 'Specs/renamed',
          allIds: WIKI_IDS,
        },
        // Ambiguous bare leaf never resolves to oldId → kept.
        {
          text: 'tonight: [[pasta]]',
          oldId: 'Recipes/pasta',
          newId: 'Recipes/spaghetti',
          allIds: WIKI_IDS,
        },
        // Unique path-suffix link IS rewritten (resolution, not string match).
        {
          text: 'see [[Dinner/pasta]]',
          oldId: 'Recipes/Dinner/pasta',
          newId: 'Recipes/Dinner/lasagna',
          allIds: WIKI_IDS,
        },
        // Link to a DIFFERENT note whose leaf matches oldId's leaf → kept.
        {
          text: 'see [[notes]]',
          oldId: 'Projects/notes',
          newId: 'Projects/notes-v2',
          allIds: WIKI_IDS,
        },
        // Code fences get rewritten too — the rule is text-level.
        {
          text: '```\n[[grocery list]]\n```',
          oldId: 'grocery list',
          newId: 'Lists/grocery list',
          allIds: WIKI_IDS,
        },
        // Unicode + emoji targets.
        {
          text: 'voir [[café résumé]]',
          oldId: 'Unicode/café résumé',
          newId: 'Unicode/CV',
          allIds: WIKI_IDS,
        },
        {
          text: 'allons [[🎉 party]] !',
          oldId: 'Emoji/🎉 party',
          newId: 'Emoji/🎊 fiesta',
          allIds: WIKI_IDS,
        },
        // Newline inside the brackets is not a link.
        {
          text: '[[grocery\nlist]]',
          oldId: 'grocery list',
          newId: 'Lists/grocery list',
          allIds: WIKI_IDS,
        },
        // WIKILINK_RE swallows a nested `[[` → whole inner is the (broken) target.
        {
          text: 'weird [[a[[grocery list]] end',
          oldId: 'grocery list',
          newId: 'Lists/grocery list',
          allIds: WIKI_IDS,
        },
        // `[[a]]]` closes at the FIRST `]]`.
        {
          text: '[[grocery list]]] tail',
          oldId: 'grocery list',
          newId: 'Lists/grocery list',
          allIds: WIKI_IDS,
        },
        // No links at all → zero rewrites.
        {
          text: 'plain text, no links',
          oldId: 'grocery list',
          newId: 'Lists/grocery list',
          allIds: WIKI_IDS,
        },
        // oldId === newId still COUNTS rewrites (text is unchanged) — pins
        // the TS behavior that counting happens before any change check.
        {
          text: '[[notes]]',
          oldId: 'notes',
          newId: 'notes',
          allIds: WIKI_IDS,
        },
      ].map(({ text, oldId, newId, allIds }) => ({
        input: { text, oldId, newId, allIds },
        expected: rewriteWikilinks(text, oldId, newId, allIds),
      })),
    },
  ],
};

// ── Fuzz / adversarial inputs (plan §Phase 1) ───────────────────────────
//
// These exercise the JS↔Rust landmines: emoji + control chars, nested /
// unclosed code fences, case-collision, and `../../etc` traversal. The
// `expected` values are computed by the TS reference, so a Rust divergence
// fails `crates/futo-notes-model/tests/conformance.rs`.
//
// IMPORTANT: every input here is chosen so JS and Rust agree exactly:
//   - `sanitizeTitle` / `normalizeTagName` outputs are character-identical
//     regardless of UTF-16-vs-UTF-8, so emoji are safe.
//   - `validateTitle` length now counts UTF-16 units on both sides.
//   - `extractTags` results are ASCII tags, representation-independent — emoji
//     may appear in the *content* but never in a captured tag.
//   - `extractHeaderTagBlock` returns a byte offset in Rust vs UTF-16 in JS,
//     so its fuzz inputs stay ASCII (offsets agree); `remainder` is compared
//     too and is representation-independent.
const EMOJI = '🎉👨‍👩‍👧‍👦🇺🇸';

const fuzzFilename = {
  op: 'sanitizeTitle',
  fn: 'sanitizeTitle',
  cases: [
    `note ${EMOJI} title`,
    `${EMOJI}`,
    `a<b>${EMOJI}c:d`,
    'tab\there\nnewline',
    'café résumé naïve', // combining-friendly Latin
    'Ωμέγα Ελληνικά',
    'بسم الله', // RTL
    `${'x'.repeat(199)}${EMOJI}`, // long + emoji (sanitize never truncates)
  ].map((input) => ({ input, expected: sanitizeTitle(input) })),
};

const fuzzValidateTitle = {
  op: 'validateTitle',
  fn: 'validateTitle',
  cases: [
    `valid ${EMOJI} title`, // emoji, well under length → []
    `${'a'.repeat(201)} ${EMOJI}`, // clearly too long
    `.${EMOJI}.`, // leading + trailing dot
    'control\x07char', // bell = forbidden
  ].map((input) => ({ input, expected: kinds(validateTitle(input)) })),
};

const fuzzTags = {
  op: 'extractTags',
  fn: 'extractTags',
  cases: [
    // Emoji around real tags — tags survive, emoji ignored.
    `${EMOJI} #realtag more ${EMOJI}`,
    // Nested fences: a ``` block containing a ~~~ line; inner tags hidden.
    '#outside\n\n```\n~~~\n#hidden\n~~~\n```\n\n#after',
    // Unclosed fence runs to EOF — everything after is hidden.
    '#before\n````\n#hidden\nstill hidden',
    // Fence with an info string (```rust) still strips its body.
    '#a\n\n```rust\nlet x = "#nope";\n```\n\n#b',
    // Inline code with backtick run of 2.
    'text ``#notatag`` and #yestag here',
    // Tag immediately followed by emoji is NOT a valid terminator → dropped.
    '#tag🎉 but #clean works',
    // Deeply repeated to stress the scanner.
    '#one #two #three #one #two', // dedup
  ].map((input) => ({ input, expected: extractTags(input) })),
};

const fuzzFolderPath = {
  op: 'validateFolderPath',
  fn: 'validateFolderPath',
  cases: [
    '../../etc/passwd',
    'a/../b',
    'a/./b',
    'good/../../bad',
    Array.from({ length: 15 }, (_, i) => `d${i}`).join('/'), // depth blown
    'CON/sub',
    'ok/NUL',
    'a//b//c',
    'Specs/Sub/Deep', // valid
  ].map((input) => ({ input, expected: kinds(validateFolderPath(input)) })),
};

const fuzzCaseCollision = {
  op: 'hasCaseInsensitiveSiblingCollision',
  fn: 'hasCaseInsensitiveSiblingCollision',
  cases: [
    { name: 'Notes', siblings: ['NOTES', 'Other'] },
    { name: 'notes', siblings: ['Other', 'Misc'] },
    { name: 'AbC', siblings: ['aBc'] },
    { name: 'x', siblings: [] },
  ].map((c) => ({
    input: c,
    expected: hasCaseInsensitiveSiblingCollision(c.name, c.siblings),
  })),
};

const fuzzHeaderBlock = {
  op: 'extractHeaderTagBlock',
  fn: 'extractHeaderTagBlock',
  cases: [
    '#a #b #c\n#d #e\n\nbody', // multi-line block + blank separator
    '#tag\t \n\ncontent', // trailing whitespace on tag line
    '#x\n#y\n#z', // block runs to EOF
    'no tags here\n#late', // no header block
    '#a\nplain text\n#b', // stops at first non-tag line
  ].map((input) => {
    const { tags, endOffset } = extractHeaderTagBlock(input);
    return { input, expected: { tags, endOffset, remainder: input.slice(endOffset) } };
  }),
};

filename.groups.push(fuzzFilename, fuzzValidateTitle, fuzzFolderPath, fuzzCaseCollision);
tags.groups.push(fuzzTags, fuzzHeaderBlock);

const FIXTURES = { filename, tags, image, preview, wikilinks };

const banner =
  '// GENERATED by tests/conformance/generate.mjs — do not edit by hand.\n' +
  '// Run `pnpm exec tsx tests/conformance/generate.mjs` to regenerate.\n';

function serialize(name, data) {
  // We can't put a JS comment in JSON, so carry provenance in a field.
  const withMeta = { _generated: 'tests/conformance/generate.mjs', ...data };
  return JSON.stringify(withMeta, null, 2) + '\n';
}

const check = process.argv.includes('--check');
let stale = false;
let total = 0;

for (const [name, data] of Object.entries(FIXTURES)) {
  const path = join(HERE, `${name}.json`);
  const next = serialize(name, data);
  const count = data.groups.reduce((n, g) => n + g.cases.length, 0);
  total += count;
  if (check) {
    const prev = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (prev !== next) {
      stale = true;
      console.error(`STALE: ${name}.json differs from generator output`);
    }
  } else {
    writeFileSync(path, next);
    console.log(`wrote ${name}.json (${count} cases)`);
  }
}

void banner;
if (check && stale) {
  console.error(
    'Conformance fixtures are stale. Run: pnpm exec tsx tests/conformance/generate.mjs',
  );
  process.exit(1);
}
if (!check) console.log(`total: ${total} conformance cases`);
