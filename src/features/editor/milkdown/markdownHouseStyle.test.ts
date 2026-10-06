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
