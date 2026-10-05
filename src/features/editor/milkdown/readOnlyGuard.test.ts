import { describe, expect, it } from 'vitest';

import { EditorState } from '@milkdown/kit/prose/state';

import { testSchema as s } from './__fixtures__/schema';
import { allowedWhileReadOnly } from './readOnlyGuard';

const state = EditorState.create({
  doc: s.nodes.doc.create(null, [s.nodes.paragraph.create(null, s.text('Milk'))]),
});

describe('allowedWhileReadOnly', () => {
  // Enter, Backspace, Mod-B and a dropped image all arrive as ordinary edits.
  it('refuses an edit while read-only', () => {
    expect(allowedWhileReadOnly(state.tr.insertText('!', 5), true)).toBe(false);
  });

  it('lets the editor load a note while read-only', () => {
    const load = state.tr.insertText('Eggs', 1).setMeta('addToHistory', false);
    expect(allowedWhileReadOnly(load, true)).toBe(true);
  });

  it('lets selection moves through while read-only', () => {
    expect(allowedWhileReadOnly(state.tr.scrollIntoView(), true)).toBe(true);
  });

  it('allows edits to a writable note', () => {
    expect(allowedWhileReadOnly(state.tr.insertText('!', 5), false)).toBe(true);
  });
});
