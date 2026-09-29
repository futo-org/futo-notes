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
