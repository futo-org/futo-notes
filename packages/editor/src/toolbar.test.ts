import { describe, it, expect } from 'vitest';
import { TOOLBAR_GROUPS, TOOLBAR_DISMISS, TOOLBAR_ITEMS, TOOLBAR_EXEC_IDS } from './toolbar';

describe('toolbar manifest', () => {
  it('ids are unique', () => {
    const ids = TOOLBAR_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every item names an icon for every platform renderer', () => {
    for (const item of TOOLBAR_ITEMS) {
      expect(item.lucide, item.id).toBeTruthy();
      expect(item.sfSymbol, item.id).toBeTruthy();
      expect(item.material, item.id).toBeTruthy();
      expect(item.label, item.id).toBeTruthy();
    }
  });

  it('pins the toolbar surface (order, grouping, visibility)', () => {
    // This IS the toolbar across all three apps — a change here must be a
    // deliberate spec change (docs/spec/editor.md) and requires regenerating
    // the native specs (`just toolbar-spec`).
    expect(
      TOOLBAR_GROUPS.map((g) => g.map((i) => (i.when === 'onListLine' ? `${i.id}?` : i.id))),
    ).toEqual([
      ['bold', 'italic', 'strikethrough'],
      ['heading', 'quote'],
      ['bullet-list', 'ordered-list', 'task-list', 'outdent?', 'indent?'],
      ['camera', 'image'],
    ]);
    expect(TOOLBAR_DISMISS.id).toBe('dismiss');
    expect(TOOLBAR_DISMISS.action).toEqual({ kind: 'dismiss' });
  });

  it('exec ids cover exactly the exec items', () => {
    expect(TOOLBAR_EXEC_IDS).toEqual([
      'bold',
      'italic',
      'strikethrough',
      'heading',
      'quote',
      'bullet-list',
      'ordered-list',
      'task-list',
      'outdent',
      'indent',
    ]);
  });

  it('image items request the matching picker source', () => {
    const camera = TOOLBAR_ITEMS.find((i) => i.id === 'camera');
    const image = TOOLBAR_ITEMS.find((i) => i.id === 'image');
    expect(camera?.action).toEqual({ kind: 'pickImage', source: 'camera' });
    expect(image?.action).toEqual({ kind: 'pickImage', source: 'library' });
  });
});
