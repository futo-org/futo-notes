import { expect, it } from 'vitest';

import { testSchema as s } from '../__fixtures__/schema';
import { linkRunAt } from './linkEditing';

it('keeps repeated links with the same URL separate across unlinked text', () => {
  const link = s.marks.link.create({ href: 'https://example.test' });
  const doc = s.nodes.doc.create(null, [
    s.nodes.paragraph.create(null, [s.text('one', [link]), s.text(' gap '), s.text('two', [link])]),
  ]);

  expect(linkRunAt(doc, 2)).toMatchObject({ from: 1, to: 4 });
  expect(linkRunAt(doc, 10)).toMatchObject({ from: 9, to: 12 });
});
