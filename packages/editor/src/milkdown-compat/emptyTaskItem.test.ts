import { fromMarkdown } from 'mdast-util-from-markdown';
import { describe, expect, it } from 'vitest';

import { markEmptyTaskItems } from './emptyTaskItem';
import type { MdastNode } from './mdast';

const text = (value: string): MdastNode => ({ type: 'text', value });
const item = (...children: MdastNode[]): MdastNode => ({ type: 'listItem', children });
const para = (...children: MdastNode[]): MdastNode => ({ type: 'paragraph', children });
const run = (node: MdastNode) =>
  markEmptyTaskItems({ type: 'root', children: [{ type: 'list', children: [node] }] });

describe('markEmptyTaskItems', () => {
  it('reads `- [ ]` as an empty unchecked task item', () => {
    const li = item(para(text('[ ]')));
    run(li);
    expect(li.checked).toBe(false);
    expect(li.children).toEqual([{ type: 'paragraph', children: [] }]);
  });

  it('reads `- [x]` and `- [X]` as an empty checked task item', () => {
    for (const marker of ['[x]', '[X]']) {
      const li = item(para(text(marker)));
      run(li);
      expect(li.checked).toBe(true);
    }
  });

  it('keeps the nested blocks of an empty task item', () => {
    const nested: MdastNode = { type: 'list', children: [] };
    const li = item(para(text('[ ]')), nested);
    run(li);
    expect(li.checked).toBe(false);
    expect(li.children).toEqual([{ type: 'paragraph', children: [] }, nested]);
  });

  it('leaves an item with real text or an existing state alone', () => {
    const withText = item(para(text('[ ] more')));
    const alreadyTask = { ...item(para(text('[ ]'))), checked: true };
    for (const li of [withText, alreadyTask]) run(li);
    expect(withText.checked).toBeUndefined();
    expect(alreadyTask.checked).toBe(true);
    expect(alreadyTask.children?.[0].children).toEqual([text('[ ]')]);
  });
});

/*
 * The FB-7 follow-up: an explicitly ESCAPED `- \[ \]` reads as the same text
 * node `[ ]` as a bare `- [ ]` does (the parser resolves the escapes), so the
 * value alone cannot tell them apart and the user's escape was lost. The text
 * node's SOURCE span can: a literal marker is exactly 3 characters wide, the
 * escaped spelling is 5. These cases use the real parser so the spans are the
 * ones the editor sees.
 */
describe('markEmptyTaskItems against real source spans', () => {
  const parseItem = (markdown: string): MdastNode => {
    const tree = fromMarkdown(markdown) as unknown as MdastNode;
    markEmptyTaskItems(tree);
    return tree.children![0].children![0];
  };

  it('still reads a bare `- [ ]` as an empty task item', () => {
    const li = parseItem('- [ ]\n');
    expect(li.checked).toBe(false);
    expect(li.children).toEqual([expect.objectContaining({ type: 'paragraph', children: [] })]);
  });

  it('still reads a bare `- [x]` as an empty checked task item', () => {
    expect(parseItem('- [x]\n').checked).toBe(true);
  });

  it('keeps an escaped `- \\[ \\]` literal, as the user wrote it', () => {
    const li = parseItem('- \\[ \\]\n');
    expect(li.checked ?? null).toBeNull();
    expect(li.children?.[0].children?.[0]).toMatchObject({ type: 'text', value: '[ ]' });
  });

  it('keeps a half-escaped `- \\[x]` literal too', () => {
    expect(parseItem('- \\[x]\n').checked ?? null).toBeNull();
  });
});
