// Part of the Milkdown compat suite: the round-trip contract is described in
// editor-embed-milkdown-compat.spec.ts.

import { expect, test } from '@playwright/test';
import { useCensusPage, twoSaves, withoutMarkers } from './lib/editorEmbedMilkdownCompat';

useCensusPage();

test.describe('an attention run never invents a character reference (RC-104)', () => {
  // Milkdown trims a mark's edge spaces out of the mark and leaves the emptied
  // text node behind, so the first child of a link can be `''`. The remark-era
  // encoder compared the empty neighbour with the empty previous result and
  // wrote `&#xNAN;` into the note, on the first save of any note holding the
  // shape. None of these needs a reference at all.
  const SHAPES: Record<string, string> = {
    // the reported repro; the bold hoisted out of the link is upstream's own
    // re-spelling (the baseline writes the same links) and is not asserted away
    'a link over two bold runs and a bold-italic run': '[**a** ***b*** **c**](https://e.com/u)\n',
    'a link over a bold run and a bold-italic run': '[**a** ***b***](u)\n',
    'a link over a bold run and an underscore bold': '[**a** __b__ **c**](u)\n',
    'a link over a bold run then an italic whose edge is punctuation': '[**a** *:b*](u)\n',
    'a link that opens with a space then an underscore italic': '[ _a_](u)\n',
    'a link that opens and closes with a space around an underscore italic': '[ _a_ ](u)\n',
    'the same shape in a blockquote': '> [**a** ***b*** **c**](u)\n',
    'the same shape in a list item': '- [**a** ***b*** **c**](u)\n',
    'the same shape in a heading': '# [**a** ***b*** **c**](u)\n',
    'the same shape in a table cell': '| h |\n| --- |\n| [**a** ***b*** **c**](u) |\n',
  };

  for (const [name, markdown] of Object.entries(SHAPES)) {
    test(`compat writes no reference for ${name}`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).not.toMatch(/&#/);
      expect(twice).not.toMatch(/&#|\\&/);
    });
  }

  test('a single character whose two edges both want encoding needs none', async ({ page }) => {
    // `x_a_y` is not emphasis; the entities make the intraword `_` run
    // reachable. The remark-era encoder cut a reference in two here
    // (`&#x61&#x3B;`), which reopened as text and gained a backslash. The house
    // style writes the italic with `*`, which opens and closes inside a word.
    const markdown = '&#x78;_a_&#x79;\n';
    const { once, twice } = await twoSaves(page, 'compat', markdown);
    expect(once).toBe('x*a*y\n');
    expect(twice).toBe(once);
  });
});

/**
 * A small seeded generator of inline markdown: text, punctuation and space
 * runs, bold / italic / strikethrough spelled every way, and links, nested to
 * depth three. Synthetic by construction — nothing here comes from a corpus.
 */
function inlineMarkdown(seed: number, depth = 0): string {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const WORDS = ['a', 'b', 'Note', 'x9', 'é', '重要', '这是', '😀', '1'];
  const EDGES = [':', '(', ')', '，', '：', '.', '"', '!', '-', ' '];
  const MARKS = ['**', '*', '_', '__', '~~', '***', '___'];
  const run = (level: number): string => {
    let out = '';
    const count = 1 + Math.floor(next() * 4);
    for (let i = 0; i < count; i++) {
      const roll = next();
      if (roll < 0.28) out += pick(WORDS);
      else if (roll < 0.38) out += pick(EDGES);
      else if (roll < 0.5) out += ' ';
      else if (level >= 3) out += pick(WORDS);
      else if (roll < 0.85) {
        const mark = pick(MARKS);
        out += mark + run(level + 1) + mark;
      } else out += `[${run(level + 1)}](https://e.com/u)`;
    }
    return out;
  };
  return run(depth);
}

const CONTAINERS: Record<string, (inline: string) => string> = {
  paragraph: (x) => `${x}\n`,
  heading: (x) => `## ${x}\n`,
  blockquote: (x) => `> ${x}\n`,
  'bullet item': (x) => `- ${x}\n`,
  'ordered item': (x) => `1. ${x}\n`,
  'task item': (x) => `- [ ] ${x}\n`,
  'table cell': (x) => `| h |\n| --- |\n| ${x} |\n`,
  'link label': (x) => `[${x}](https://e.com/u)\n`,
  'image alt': (x) => `![${x}](p.png)\n`,
  'nested quote list': (x) => `> - ${x}\n`,
};

test.describe('random mark runs inside every container never gain a reference (RC-104)', () => {
  // 400, not 200: the house style writes a reference only where a parse says
  // flanking needs one, so it takes more draws to reach the encoder the
  // handful of times the check below asks for.
  const PER_CONTAINER = 400;

  for (const [name, wrap] of Object.entries(CONTAINERS)) {
    test(`compat: ${name}`, async ({ page }) => {
      const cases = Array.from({ length: PER_CONTAINER }, (_, i) =>
        wrap(inlineMarkdown(0x9e3779b1 * (i + 1) + name.length * 7919)),
      );
      const results = await page.evaluate(async (inputs) => {
        const load = window.__futoCensus.load;
        const out = [];
        for (const input of inputs) {
          const c1 = await load('compat', input);
          const c2 = await load('compat', c1.markdown);
          const b1 = await load('baseline', input);
          const b2 = await load('baseline', b1.markdown);
          out.push({
            input,
            saved: c1.markdown,
            docs: [c1.docJson, c2.docJson, b1.docJson, b2.docJson],
          });
        }
        return out;
      }, cases);

      // A tool's silence is not evidence: the generator has to reach the
      // encoder, or an all-green run proves nothing. (An image's alt text
      // keeps no marks, so it is the one container with nothing to encode.)
      if (name !== 'image alt') {
        expect(results.filter((r) => r.saved.includes('&#x')).length).toBeGreaterThan(5);
      }
      const inputChars = (input: string) => new Set(Array.from(input));
      for (const r of results) {
        // The generator writes no `&`: every `&` in a save is an encoding the
        // editor chose, and it must be a well-formed reference to a character
        // the note already had — never NaN, undefined, or a half-cut `&#x61`.
        const refs = r.saved.match(/&[^\s]{0,12}/g) ?? [];
        for (const ref of refs) {
          const ok = /^&#x[0-9A-F]{1,6};/.exec(ref);
          expect(
            ok,
            `malformed reference ${ref} saving ${JSON.stringify(r.input)} as ${JSON.stringify(r.saved)}`,
          ).not.toBeNull();
          const char = String.fromCodePoint(parseInt((ok as RegExpExecArray)[0].slice(3, -1), 16));
          expect(
            inputChars(r.input).has(char),
            `reference to a character the note never had in ${JSON.stringify(r.saved)}`,
          ).toBe(true);
        }
        expect(r.saved).not.toMatch(/NaN|undefined/);
        // parse(serialize(doc)) equals doc — at least whenever the unpatched
        // preset manages it, so the assertion is about what THIS layer adds.
        // Compared with only a mark's `*`/`_` marker taken out
        // (`withoutMarkers`): it is how the file spelled the run, which the
        // house style does not remember. Nothing else is forgiven.
        const [c1, c2, b1, b2] = r.docs.map(withoutMarkers);
        if (b1 === b2) {
          expect(
            c2,
            `the document changed on reopen: ${JSON.stringify(r.input)} saved as ${JSON.stringify(r.saved)}`,
          ).toBe(c1);
        }
      }
    });
  }
});
