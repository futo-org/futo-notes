import { describe, expect, it } from 'vitest';
import { handleWindowDragOver, handleWindowDrop } from './externalFileDropGuard';

/** jsdom has no DragEvent/DataTransfer — fake the minimal surface. */
function fakeDragEvent(types: string[]): DragEvent & { defaultPrevented: boolean } {
  let prevented = false;
  return {
    dataTransfer: { types, dropEffect: 'copy' },
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as DragEvent & { defaultPrevented: boolean };
}

describe('externalFileDropGuard', () => {
  it('blocks external file drags (prevents webview navigation)', () => {
    const over = fakeDragEvent(['Files']);
    handleWindowDragOver(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('none');

    const drop = fakeDragEvent(['Files']);
    handleWindowDrop(drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  it('ignores internal note/folder drags (custom MIME types)', () => {
    const over = fakeDragEvent(['application/futo-note-id']);
    handleWindowDragOver(over);
    expect(over.defaultPrevented).toBe(false);
    expect(over.dataTransfer!.dropEffect).toBe('copy');

    const drop = fakeDragEvent(['application/futo-folder-path']);
    handleWindowDrop(drop);
    expect(drop.defaultPrevented).toBe(false);
  });

  it('ignores events with no dataTransfer', () => {
    const e = {
      dataTransfer: null,
      preventDefault: () => {
        throw new Error('must not preventDefault');
      },
    } as unknown as DragEvent;
    handleWindowDragOver(e);
    handleWindowDrop(e);
  });
});
