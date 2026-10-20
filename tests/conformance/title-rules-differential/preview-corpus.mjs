/**
 * Probe inputs for the preview family (preview.json).
 */

import {
  ASTRAL,
  FAMILY,
  PARTY,
  WHITESPACE_ISH,
  sample,
  unique,
  xorshift32,
} from './seeded-random-and-charsets.mjs';

// --- Family: preview (preview.json) ----------------------------------------

export function previewCorpus() {
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
