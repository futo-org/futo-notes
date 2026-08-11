// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildWikilinkIndex } from '$shared/note/wikilinks';

const VAULT = ['A/grocery', 'B/grocery', 'Specs/folder-support', 'lone'];

const getWikilinkIndex = vi.fn(() => buildWikilinkIndex(VAULT));
const getAllNotes = vi.fn(() => VAULT.map((id) => ({ id })));

vi.mock('$features/notes/notes.svelte', () => ({ getWikilinkIndex, getAllNotes }));

const { addWikilinkDecorations } = await import('./wikilinkDecorations');

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
  vi.clearAllMocks();
});

function decorate(content: string) {
  const view = new EditorView({ doc: content, parent: document.body });
  views.push(view);
  const decorations: {
    from: number;
    to: number;
    value: { class?: string; widget?: unknown; replace?: boolean };
  }[] = [];
  addWikilinkDecorations(view, decorations, [{ from: 0, to: view.state.doc.length }]);
  return decorations;
}

describe('wikilink decorations', () => {
  it('renders a unique suffix for a resolved link and marks an ambiguous one broken', () => {
    const classes = decorate('see [[folder-support]] and [[grocery]] and [[lone]]')
      .map((decoration) => decoration.value.class)
      .filter(Boolean);

    expect(classes).toEqual([
      'cm-md-link cm-md-wikilink',
      'cm-md-link cm-md-wikilink cm-md-wikilink-broken',
      'cm-md-link cm-md-wikilink',
    ]);
  });

  // The per-keystroke guard: the vault is read once per rebuild, not once per
  // link. Resolving through the id list per link is what made typing in a note
  // full of wikilinks cost O(vault) per character.
  it('builds the vault index once per rebuild regardless of how many links it sees', () => {
    decorate('[[lone]]');
    expect(getWikilinkIndex).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    decorate(Array.from({ length: 60 }, () => 'x [[lone]] y').join('\n'));
    expect(getWikilinkIndex).toHaveBeenCalledTimes(1);
    expect(getAllNotes).not.toHaveBeenCalled();
  });
});
