/*
 * The serializer's parse-or-not pre-filter (`packages/editor/src/markdown/`:
 * `inline.ts` `ALWAYS`/`LINE_START`/`plausible`, and `serializer.ts`, which
 * writes a block with no listed character without parsing it) is a list of
 * characters and contexts that COULD be syntax. Everything it leaves out is
 * written bare with no parse to check it, so a gap in the list is silent
 * content loss: `+ x` at a line's start written bare would reopen as a list.
 *
 * This property makes a gap loud. Random paragraphs and headings are built
 * only from characters the list does not name unconditionally (letters,
 * digits, spaces, and the ASCII punctuation outside `ALWAYS` — the ones the
 * filter claims are harmless outside the contexts it lists), with line breaks
 * and formatting between them, written with the REAL shipping parser, and read
 * back: the reading must be the document (compared as the census
 * `content_loss` gate compares, `houseDocument`), and a second save must write
 * the same bytes.
 *
 * Left out of the alphabet on purpose: `ALWAYS` (always parsed, so not the
 * pre-filter's claim), and `@`, because GFM reads `x@y.z` as an email link
 * whatever the escapes (plain text it would link has no spelling, see
 * `choose.ts`).
 */
// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createMarkdownSerializer,
  type MarkdownSerializer,
  type NodeJson,
} from '@futo-notes/editor/markdown';
import { houseDocument } from '../../../../tests/milkdown-census/detectors.mjs';
import { createShippingParser, type ShippingParser } from './__fixtures__/shippingParser';

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZéßñ中文';
const DIGITS = '0123456789';
/** ASCII punctuation minus `inline.ts` `ALWAYS` (`\` `` ` `` `*` `~` `[` `]` `<` `|`) and `@`. */
const PUNCTUATION = '!"#$%&\'()+,-./:;=>?^_{}';

/** mulberry32: a seeded generator, so a failure names a case that reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed: number) {
  const next = random(seed);
  const pick = <T>(items: readonly T[] | string): T =>
    items[Math.floor(next() * items.length)] as T;

  /** Punctuation often, and in runs, since it is what the filter is about. */
  function character(): string {
    const roll = next();
    if (roll < 0.35) return pick(LETTERS);
    if (roll < 0.45) return pick(DIGITS);
    if (roll < 0.62) return ' ';
    if (roll < 0.64) return '\t';
    return pick(PUNCTUATION);
  }

  function text(): string {
    // A line that starts with a block opener is the risky case: make it common.
    const openers = ['# ', '- ', '+ ', '> ', '1. ', '2) ', '---', '===', '    ', '&amp;', '&#35;'];
    let out = next() < 0.15 ? pick(openers) : '';
    const length = 1 + Math.floor(next() * 12);
    for (let index = 0; index < length; index += 1) out += character();
    return out;
  }

  function marks(): { type: string }[] | undefined {
    const roll = next();
    if (roll < 0.8) return undefined;
    if (roll < 0.85) return [{ type: 'inlineCode' }];
    const chosen = ['strong', 'emphasis', 'strike_through'].filter(() => next() < 0.5);
    return chosen.length > 0 ? chosen.map((type) => ({ type })) : undefined;
  }

  function inline(lines: boolean): NodeJson[] {
    const content: NodeJson[] = [];
    const count = 1 + Math.floor(next() * 6);
    for (let index = 0; index < count; index += 1) {
      if (lines && index > 0 && next() < 0.35) {
        content.push({ type: 'hardbreak', attrs: { isInline: next() < 0.8 } });
      }
      const node: NodeJson = { type: 'text', text: text() };
      const chosen = marks();
      content.push(chosen ? { ...node, marks: chosen } : node);
    }
    return content;
  }

  return (): NodeJson => {
    const block: NodeJson =
      next() < 0.75
        ? { type: 'paragraph', content: inline(true) }
        : {
            type: 'heading',
            attrs: { level: 1 + Math.floor(next() * 6), id: '' },
            content: inline(false),
          };
    return { type: 'doc', content: [block] };
  };
}

const SEED = 266;
const CASES = 1500;

let parser: ShippingParser;
let serializer: MarkdownSerializer;

beforeAll(async () => {
  parser = await createShippingParser();
  serializer = createMarkdownSerializer({ parse: parser.parse });
});

afterAll(async () => {
  await parser.destroy();
});

describe('the parse-or-not pre-filter', () => {
  it('writes nothing it skipped checking that reads back as a different document', () => {
    const nextDocument = generator(SEED);
    let unchecked = 0;
    for (let index = 0; index < CASES; index += 1) {
      const doc = nextDocument();
      const [block] = doc.content ?? [];
      const { checked } = serializer.serializeBlock(block as NodeJson, {
        listMarker: null,
        references: '',
      });
      if (!checked) unchecked += 1;
      const written = serializer.serialize(doc);
      const label = `seed ${SEED} case ${index} (${checked ? 'checked' : 'NOT checked'}): ${JSON.stringify(doc)}\nwrote ${JSON.stringify(written)}`;
      const reread = parser.parse(written);
      expect(houseDocument(reread), label).toBe(houseDocument(doc));
      expect(serializer.serialize(reread), label).toBe(written);
    }
    // The property is only about the filter if many blocks took the no-parse path.
    expect(unchecked).toBeGreaterThan(CASES / 4);
  });
});
