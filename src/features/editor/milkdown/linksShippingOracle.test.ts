// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createMarkdownSerializer,
  type MarkdownSerializer,
  type NodeJson,
} from '@futo-notes/editor/markdown';
import { createShippingParser, type ShippingParser } from './__fixtures__/shippingParser';

let parser: ShippingParser;
let serializer: MarkdownSerializer;
beforeAll(async () => {
  parser = await createShippingParser();
  serializer = createMarkdownSerializer({ parse: parser.parse });
});
afterAll(async () => {
  await parser.destroy();
});

const plain = (text: string): NodeJson => ({ type: 'text', text });
const link = (text: string, href: string): NodeJson => ({
  type: 'text',
  text,
  marks: [{ type: 'link', attrs: { href, title: '' } }],
});
const document = (content: NodeJson[]): NodeJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content }],
});

it('pins the shipping save spelling of literal typed link delimiters around a URL run', () => {
  // The real-input parity suite pins that these are the runs produced by typing.
  // This public serializer seam pins their exact save/reopen spelling separately.
  const doc = document([plain('[t]('), link('https://x.test', 'https://x.test'), plain(') ok')]);
  expect(serializer.serialize(doc)).toBe('\\[t](https://x.test) ok\n');
  expect(serializer.serialize(parser.parse('\\[t](https://x.test) ok\n'))).toBe(
    '\\[t](https://x.test) ok\n',
  );
});

it('pins the shipping save spelling of typed angle delimiters around a URL run', () => {
  const doc = document([plain('<'), link('https://x.test', 'https://x.test'), plain('> ok')]);
  expect(serializer.serialize(doc)).toBe('<<https://x.test>> ok\n');
});

it('spells a modified URL label explicitly when its retained destination differs', () => {
  const doc = document([link('https://x.test/new', 'https://x.test')]);
  expect(serializer.serialize(doc)).toBe('[https://x.test/new](https://x.test)\n');
});

function linkedRuns(node: NodeJson): { text: string; href: string; title: string }[] {
  const mark = node.marks?.find((mark) => mark.type === 'link');
  const own = mark
    ? [
        {
          text: node.text ?? '',
          href: String(mark.attrs?.href ?? ''),
          title: String(mark.attrs?.title ?? ''),
        },
      ]
    : [];
  return [...own, ...(node.content ?? []).flatMap(linkedRuns)];
}

it('reference labels resolve by canonical case folding while first duplicate definitions win', () => {
  const source =
    'See [DoCs].\n\n[docs]: https://first.test "T"\n[DOCS]: https://second.test "Unused"\n\nend\n';
  const parsed = parser.parse(source);
  expect(linkedRuns(parsed)).toEqual([{ text: 'DoCs', href: 'https://first.test', title: 'T' }]);
  expect(serializer.serialize(parsed)).toBe(
    'See [DoCs](https://first.test "T").\n\n[DOCS]: https://second.test "Unused"\n\nend\n',
  );
});

it('a used reference definition inside a container resolves a later outside label', () => {
  const source = '> [docs]: https://x.test "T"\n\nSee [docs].\n';
  const parsed = parser.parse(source);
  expect(linkedRuns(parsed)).toEqual([{ text: 'docs', href: 'https://x.test', title: 'T' }]);
  expect(serializer.serialize(parsed)).toBe('>\n\nSee [docs](https://x.test "T").\n');
});

it('references occurring only in code leave their definition unused and exact', () => {
  const source = 'use `[docs]` here\n\n[docs]: https://e.example/d\n';
  expect(linkedRuns(parser.parse(source))).toEqual([]);
  expect(serializer.serialize(parser.parse(source))).toBe(source);
  const fenced = '[docs]\n\n```md\n[docs]: https://code.test\n```\n';
  expect(linkedRuns(parser.parse(fenced))).toEqual([]);
  expect(serializer.serialize(parser.parse(fenced))).toBe(fenced);
});
