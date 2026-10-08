/*
 * The markdown house style goldens (tests/conformance/markdown-house-style.json,
 * docs/spec/editor.md "Markdown house style"), against the REAL shipping
 * parser: each source is read the way the app reads a note, written by the
 * owned serializer (`@futo-notes/editor/markdown`), and the bytes compared.
 *
 * Two properties ride along on every case, because a golden that passes by
 * writing something the parser misreads proves nothing:
 *   - the expected bytes read back as the same document (compared the way the
 *     census `content_loss` gate compares, `houseDocument`), and
 *   - writing that reread document gives the same bytes (a second save is a
 *     no-op).
 */
// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createCachedSerializer,
  createMarkdownSerializer,
  type MarkdownSerializer,
  type NodeJson,
} from '@futo-notes/editor/markdown';
import goldens from '../../../../tests/conformance/markdown-house-style.json';
// The serializer's own comparison: its parse checks accept a spelling only when this agrees.
import { canonical } from '../../../../packages/editor/src/markdown/normalize';
import { houseDocument } from '../../../../tests/milkdown-census/detectors.mjs';
import { createShippingParser, type ShippingParser } from './__fixtures__/shippingParser';

interface Golden {
  readonly name: string;
  readonly story?: number;
  readonly source?: string;
  readonly doc?: NodeJson;
  readonly expected: string;
}

const CASES = (goldens as { cases: Golden[] }).cases;

let parser: ShippingParser;
let serializer: MarkdownSerializer;

beforeAll(async () => {
  parser = await createShippingParser();
  serializer = createMarkdownSerializer({ parse: parser.parse });
});

afterAll(async () => {
  await parser.destroy();
});

function documentOf(golden: Golden): NodeJson {
  if (golden.doc) return golden.doc;
  if (golden.source === undefined) throw new Error(`${golden.name}: neither source nor doc`);
  return parser.parse(golden.source);
}

describe('markdown house style goldens', () => {
  it('covers every story the spec section draws from (#266 stories 2-22)', () => {
    const stories = new Set(CASES.map((golden) => golden.story).filter(Boolean));
    for (let story = 2; story <= 22; story += 1) expect(stories, `story ${story}`).toContain(story);
  });

  for (const golden of CASES) {
    const label = golden.story ? `story ${golden.story}: ${golden.name}` : golden.name;
    it(label, () => {
      const doc = documentOf(golden);
      const written = serializer.serialize(doc);
      expect(written).toBe(golden.expected);

      const reread = parser.parse(written);
      expect(houseDocument(reread)).toBe(houseDocument(doc));
      expect(serializer.serialize(reread)).toBe(written);
    });
  }
});

/*
 * Both copies of the house normalizations (normalize.ts `canonical`, which the
 * serializer's parse checks compare through, and the census `houseDocument`,
 * the content_loss gate) forgive whitespace at a line's start only where a
 * read drops it anyway.
 */
describe('the comparisons on whitespace at a line start', () => {
  const gate = (markdown: string) => houseDocument(parser.parse(markdown));
  const serializerReading = (doc: NodeJson) => canonical(doc.content ?? []);

  // Each pair: what the parser keeps, and a save that dropped it.
  it.each([
    ['after a task item checkbox', '- [ ]  x', '- [ ] x'],
    ['after a checked task box, before bold', '1. [x]   **a**', '1. [x] **a**'],
    ['inside a link at the line start', '[ a](u)', '[a](u)'],
    ['inside a code span at the line start', '` c`', '`c`'],
  ])('flag a save that drops the space %s', (_where, kept, dropped) => {
    expect(gate(dropped), 'houseDocument').not.toBe(gate(kept));
    expect(serializerReading(parser.parse(dropped)), 'canonical').not.toBe(
      serializerReading(parser.parse(kept)),
    );
  });

  it('forgive line-start whitespace the parser drops on read', () => {
    const typed: NodeJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '  a', marks: [{ type: 'strong', attrs: { marker: '*' } }] },
            { type: 'hardbreak', attrs: { isInline: true } },
            { type: 'text', text: '\tb' },
          ],
        },
      ],
    };
    expect(houseDocument(typed)).toBe(gate('**a**\nb'));
    expect(serializerReading(typed)).toBe(serializerReading(parser.parse('**a**\nb')));
  });
});

describe('the per-block save cache', () => {
  /** A JSON document whose blocks keep their identity, as ProseMirror nodes do across a transaction. */
  const adapter = {
    children: (doc: NodeJson) => doc.content ?? [],
    toJSON: (block: NodeJson) => block,
  };

  it('writes every golden byte-for-byte as the whole-document serializer does', () => {
    const cached = createCachedSerializer(serializer, adapter);
    for (const golden of CASES) {
      const doc = documentOf(golden);
      expect(cached.serialize(doc), golden.name).toBe(serializer.serialize(doc));
    }
  });

  it('writes only the block that changed, and re-plans the list markers around it', () => {
    let writes = 0;
    const counting: MarkdownSerializer = {
      ...serializer,
      serializeBlock: (block, context) => {
        writes += 1;
        return serializer.serializeBlock(block, context);
      },
    };
    const cached = createCachedSerializer(counting, adapter);
    const doc = parser.parse('- a\n\ntext\n\n* b\n\n# end');
    expect(cached.serialize(doc)).toBe('- a\n\ntext\n\n- b\n\n# end\n');
    expect(writes).toBe(4);
    expect(cached.isPrimed(doc)).toBe(true);

    // The paragraph between the lists becomes an empty one: the second list
    // now touches the first, so it alone is rewritten with the other marker.
    const content = doc.content ?? [];
    const edited: NodeJson = {
      ...doc,
      content: [content[0]!, { type: 'paragraph' }, ...content.slice(2)],
    };
    writes = 0;
    expect(cached.serialize(edited)).toBe('- a\n\n\n* b\n\n# end\n');
    expect(writes).toBe(1);
  });

  it('checks a list item by item and a table cell by cell, never the whole block', () => {
    const parsed: string[] = [];
    const watching = createMarkdownSerializer({
      parse: (markdown) => {
        parsed.push(markdown);
        return parser.parse(markdown);
      },
    });
    const items = Array.from({ length: 50 }, (_, index) => `- item ${index}`);
    const list = parser.parse([...items.slice(0, 20), '- \\*not italic\\*', ...items].join('\n'));
    const table = parser.parse('| a | b |\n| --- | --- |\n| x \\| y | z |');
    expect(watching.serialize(list)).toBe(
      `${[...items.slice(0, 20), '- \\*not italic*', ...items].join('\n')}\n`,
    );
    expect(watching.serialize(table)).toBe('| a | b |\n| --- | --- |\n| x \\| y | z |\n');
    expect(parsed.length).toBeGreaterThan(0);
    // Every parse is of one item or one cell (plus a one-cell table's delimiter row).
    for (const markdown of parsed) expect(markdown.length).toBeLessThan(30);
  });

  it('primes in slices and reports when it is done', () => {
    const cached = createCachedSerializer(serializer, adapter);
    const doc = parser.parse('a\n\nb\n\nc');
    expect(cached.prime(doc, () => 0)).toBe(false);
    expect(cached.isPrimed(doc)).toBe(false);
    expect(cached.prime(doc, () => 1000)).toBe(true);
    expect(cached.isPrimed(doc)).toBe(true);
  });
});

/*
 * A link or image destination, and a title, are character-reference territory
 * exactly like text: `&amp;` in the source reads as `&`, so a decoded `&amp;`
 * must be written so it does not decode again. A bare `&` that starts no
 * reference stays bare (byte stability of existing notes).
 */
describe('character references in link and image attributes', () => {
  const adapter = {
    children: (doc: NodeJson) => doc.content ?? [],
    toJSON: (block: NodeJson) => block,
  };

  /** [markdown source as written, what its destination/title decodes to] */
  const SOURCES = [
    ['paragraph link', '[x](a&amp;amp;b)'],
    ['paragraph link, numeric', '[x](a&amp;#38;b)'],
    ['paragraph link, title', '[x](u "&amp;copy;")'],
    ['paragraph image', '![x](a&amp;amp;b)'],
    ['paragraph image, title', '![x](u "&amp;copy;")'],
    ['table cell link', '| h |\n| --- |\n| [x](a&amp;amp;b) |'],
    ['table cell image', '| h |\n| --- |\n| ![x](a&amp;amp;b "&amp;copy;") |'],
  ] as const;

  it.each(SOURCES)('keeps what a %s decodes to', (_name, source) => {
    const doc = parser.parse(source);
    const written = serializer.serialize(doc);
    expect(houseDocument(parser.parse(written)), written).toBe(houseDocument(doc));
    expect(serializer.serialize(parser.parse(written))).toBe(written);
  });

  it('still writes a bare & that starts no reference bare', () => {
    expect(serializer.serialize(parser.parse('[x](a&b?c=1&d=2 "t&u")'))).toBe(
      '[x](a&b?c=1&d=2 "t&u")\n',
    );
    expect(serializer.serialize(parser.parse('[x](a&amp;b)'))).toBe('[x](a&b)\n');
  });

  it('keeps the destinations of an untouched block when another paragraph is edited', () => {
    const cached = createCachedSerializer(serializer, adapter);
    const doc = parser.parse('[x](a&amp;amp;b)\n\n![y](c&amp;amp;d "&amp;copy;")\n\nedit me');
    cached.serialize(doc);
    const content = doc.content ?? [];
    const edited: NodeJson = {
      ...doc,
      content: [
        content[0]!,
        content[1]!,
        { type: 'paragraph', content: [{ type: 'text', text: 'edited' }] },
      ],
    };
    const written = cached.serialize(edited);
    expect(houseDocument(parser.parse(written)), written).toBe(houseDocument(edited));
  });

  it('keeps them when the edited block is the link paragraph itself', () => {
    const doc = parser.parse('[x](a&amp;amp;b)');
    const content = doc.content ?? [];
    const written = createCachedSerializer(serializer, adapter).serialize({
      ...doc,
      content: [{ ...content[0]! }],
    });
    expect(houseDocument(parser.parse(written)), written).toBe(houseDocument(doc));
  });
});
