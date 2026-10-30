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
