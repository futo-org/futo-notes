/**
 * Probe inputs for the tags family (tags.json).
 */

import {
  CASE_TRAPS,
  PARTY,
  WHITESPACE_ISH,
  sample,
  unique,
  xorshift32,
} from './seeded-random-and-charsets.mjs';

// --- Family: tags (tags.json) ----------------------------------------------

export function tagContentCorpus() {
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

export function tagNameCorpus() {
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
