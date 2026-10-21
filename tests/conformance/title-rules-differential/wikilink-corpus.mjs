/**
 * Probe inputs for the wikilinks family (wikilinks-*.json).
 */

import { PARTY, sample, unique, xorshift32 } from './seeded-random-and-charsets.mjs';

// --- Family: wikilinks (wikilinks-*.json) ----------------------------------

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
export function wikilinkTargetCorpus() {
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
export function suffixCorpus() {
  const outsiders = ['Brand/new note', '', '/', 'a//b', 'Case/NOTES', 'leaf', 'x', 'a/x'];
  const cases = [];
  for (const allIds of WIKI_UNIVERSES) {
    for (const targetId of unique([...allIds, ...outsiders])) cases.push({ targetId, allIds });
  }
  return cases;
}

export function rewriteCorpus() {
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
