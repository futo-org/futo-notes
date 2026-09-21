// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFS } = vi.hoisted(() => ({ getFS: vi.fn() }));
vi.mock('$lib/platform', () => ({ getFS, isTauri: false }));

import { createImageInsertTarget, type ImageInsertTarget } from '../../imageInsertTarget';
import { createSlashExec } from './exec';
import { SLASH_ITEMS } from './items';

/**
 * Where a picked image goes. The editor component owns this identity in
 * production (MilkdownEditor.svelte); here it is a target over one note that
 * never changes, plus the `insert` spy the Image cases assert on.
 */
function imageTarget(insert: (filename: string) => void = vi.fn()): ImageInsertTarget {
  return createImageInsertTarget({ documentToken: () => 'the note', insert });
}

/**
 * The `/` menu's two halves must cover exactly the same set.
 *
 * `items.ts` says what the menu OFFERS and `exec.ts` says what picking one
 * DOES. An item with no implementation is a row that silently does nothing; an
 * implementation with no item is dead code. Neither file can see the other, so
 * this is the only thing holding them together — the parity check the exec
 * module's own header promises.
 */
describe('slash exec covers the offered items', () => {
  it('implements every id the menu offers, and no others', () => {
    const implemented = Object.keys(createSlashExec(() => null, imageTarget())).sort();
    const offered = SLASH_ITEMS.map((item) => item.id).sort();
    expect(implemented).toEqual(offered);
  });

  it('offers Image — the picker the CodeMirror toolbar had before the swap', () => {
    expect(SLASH_ITEMS.map((item) => item.id)).toContain('image');
  });
});

describe('the Image item', () => {
  beforeEach(() => {
    getFS.mockReset();
  });

  it('opens the host picker and inserts what comes back', async () => {
    const bytes = new ArrayBuffer(4);
    const pickImages = vi.fn().mockResolvedValue([{ bytes, extension: 'png' }]);
    const saveImageBytes = vi.fn().mockResolvedValue('image-77.png');
    getFS.mockReturnValue({
      pickImages,
      saveImageBytes,
      getImageUrl: vi.fn().mockResolvedValue('asset://image-77.png'),
    });

    const insert = vi.fn();
    createSlashExec(() => null, imageTarget(insert)).image(0, 0);

    await vi.waitFor(() => expect(insert).toHaveBeenCalledWith('image-77.png'));
    expect(pickImages).toHaveBeenCalled();
    expect(saveImageBytes).toHaveBeenCalledWith(bytes, 'png');
  });

  it('does nothing on a host with no picker, rather than throwing', async () => {
    getFS.mockReturnValue({ saveImageBytes: vi.fn(), getImageUrl: vi.fn() });

    const insert = vi.fn();
    expect(() => createSlashExec(() => null, imageTarget(insert)).image(0, 0)).not.toThrow();

    await Promise.resolve();
    expect(insert).not.toHaveBeenCalled();
  });

  it('resolves the picker at PICK time, so an FS that arrives later still works', async () => {
    // The plugin is built while the editor is still being constructed, which
    // can be before `getPlatformFS()` has resolved. Caching the answer then
    // would leave the item permanently inert on a host that does have a picker.
    getFS.mockImplementation(() => {
      throw new Error('Platform FS not initialized');
    });
    const exec = createSlashExec(() => null, imageTarget());

    const pickImages = vi.fn().mockResolvedValue([]);
    getFS.mockReset();
    getFS.mockReturnValue({
      pickImages,
      saveImageBytes: vi.fn(),
      getImageUrl: vi.fn(),
    });

    exec.image(0, 0);

    await vi.waitFor(() => expect(pickImages).toHaveBeenCalled());
  });
});

describe('the Link item', () => {
  it('does not throw with no live editor, and offers nothing to delete on a no-op editor', () => {
    // `openLinkPrompt` reads the current selection through the editor's ctx;
    // a null editor (view not built yet) must be a no-op, the same contract
    // every other item's exec function has.
    expect(() => createSlashExec(() => null, imageTarget()).link(0, 0)).not.toThrow();
  });
});
