import { describe, expect, it } from 'vitest';

import { buildWikilinkIndex } from '$shared/note/wikilinks';
import { wikilinkDisplay, WIKILINK_BROKEN_CLASS, WIKILINK_CLASS } from './display';

const VAULT = ['Projects/Roadmap', 'Archive/2024/Roadmap', 'grocery list', 'work/notes/ideas'];
const index = buildWikilinkIndex(VAULT);

describe('wikilinkDisplay', () => {
  it('shows the shortest unique path suffix for a resolved link', () => {
    // "ideas" is unique across the vault, so the folders are noise.
    expect(wikilinkDisplay('work/notes/ideas', index)).toEqual({
      text: 'ideas',
      resolvedId: 'work/notes/ideas',
      className: WIKILINK_CLASS,
    });
  });

  it('keeps as much of the path as it takes to stay unambiguous', () => {
    // Two notes end in "Roadmap", so the display has to carry the folder.
    expect(wikilinkDisplay('Projects/Roadmap', index).text).toBe('Projects/Roadmap');
  });

  it('resolves a bare leaf that names exactly one note', () => {
    expect(wikilinkDisplay('grocery list', index).resolvedId).toBe('grocery list');
  });

  it('marks an absent target broken and shows it verbatim', () => {
    // The raw text is also the title the create-on-missing path would use.
    expect(wikilinkDisplay('nothing here', index)).toEqual({
      text: 'nothing here',
      resolvedId: null,
      className: `${WIKILINK_CLASS} ${WIKILINK_BROKEN_CLASS}`,
    });
  });

  it('marks an AMBIGUOUS target broken, exactly like an absent one', () => {
    // "Roadmap" names two notes; resolveWikilink returns null for both cases and
    // the reader must be able to see that before tapping (docs/spec/editor.md).
    const ambiguous = wikilinkDisplay('Roadmap', index);
    expect(ambiguous.resolvedId).toBeNull();
    expect(ambiguous.className).toContain(WIKILINK_BROKEN_CLASS);
    expect(ambiguous.text).toBe('Roadmap');
  });

  it('does not prettify the target — the filename is the title (M2)', () => {
    const index2 = buildWikilinkIndex(['grocery list']);
    expect(wikilinkDisplay('grocery list', index2).text).toBe('grocery list');
  });
});
