// @vitest-environment jsdom
/**
 * An image saved while the editor moves on belongs to the note it was started
 * on — never to whatever note is open when the bytes land.
 *
 * P1, 2026-09-19. Saving an image is asynchronous and this component is REUSED
 * across notes: start a drop in note A, switch to note B, let the save finish,
 * and `![](image-…)` went into B. The completion had no idea which note asked
 * for it. → docs/spec/editor.md "Images"
 *
 * Driven through `PlatformFS.onFileDrop` — the Tauri drag-drop door — because
 * it reaches the same `imageInsert.ts` completion every image entry point
 * shares, and unlike an HTML5 `drop` it needs no coordinate hit-testing, which
 * jsdom has none of. The other two doors are covered at their own seams
 * (`imageInsert.test.ts`, `imagePasteSink.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick } from 'svelte';

import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';

interface FileDropPayload {
  paths: string[];
  x: number;
  y: number;
}

const { fsMock, fileDropListeners } = vi.hoisted(() => ({
  fsMock: {
    saveImagePath: vi.fn<(source: string) => Promise<string>>(),
    saveImageBytes: vi.fn(async (_data: ArrayBuffer, ext: string) => `image-pasted.${ext}`),
    getImageUrl: vi.fn(async (filename: string) => `asset://${filename}`),
    deleteFile: vi.fn(async (_filename: string) => {}),
  },
  fileDropListeners: [] as ((payload: FileDropPayload) => void)[],
}));

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  getFS: () => fsMock,
  onFileDrop: (listener: (payload: FileDropPayload) => void) => {
    fileDropListeners.push(listener);
    return () => {};
  },
}));

interface EditorHandle {
  openNote: (text: string) => void;
  getContent: () => string | undefined;
}

let target: HTMLElement;
let handle: EditorHandle;

const MilkdownEditor = (await import('./MilkdownEditor.svelte')).default;

/** A promise this test resolves by hand, so the note can change mid-save. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function mountEditor(): Promise<void> {
  target = document.createElement('div');
  document.body.appendChild(target);
  await withoutLeakedCtxTimers(async () => {
    handle = mount(MilkdownEditor, {
      target,
      props: { content: '', onchange: () => {} },
    }) as unknown as EditorHandle;
    await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull());
  });
}

/** Hands the editor a dropped file path, as Tauri's drag-drop event does. */
function dropPath(path: string): void {
  for (const listener of fileDropListeners) listener({ paths: [path], x: 0, y: 0 });
}

/**
 * Pastes an image file into the editor through ProseMirror's own `paste`
 * handler. jsdom has no constructible `ClipboardEvent`, so this is a plain
 * `paste` Event carrying the `clipboardData` shape the handler reads.
 */
function pasteImage(): void {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
    type: 'image/png',
  });
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [file],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      types: ['Files'],
      getData: () => '',
    },
  });
  target.querySelector('.ProseMirror')!.dispatchEvent(event);
}

/** Lets every already-resolved promise in the save chain run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await tick();
}

beforeEach(async () => {
  document.body.innerHTML = '';
  document.elementFromPoint = () => null;
  fileDropListeners.length = 0;
  fsMock.saveImagePath.mockReset();
  fsMock.saveImageBytes.mockReset();
  fsMock.saveImageBytes.mockImplementation(
    async (_data: ArrayBuffer, ext: string) => `image-pasted.${ext}`,
  );
  fsMock.deleteFile.mockClear();
  await mountEditor();
});

describe('an image saved while the note changes', () => {
  it('does not reach the note the user moved on to, and its file is removed', async () => {
    const save = deferred<string>();
    fsMock.saveImagePath.mockReturnValue(save.promise);

    handle.openNote('note A body');
    dropPath('/pics/holiday.png');

    handle.openNote('note B body');
    save.resolve('image-holiday.png');
    await settle();

    const content = handle.getContent();
    expect(content).toContain('note B body');
    expect(content).not.toContain('![](');
    expect(fsMock.deleteFile).toHaveBeenCalledWith('image-holiday.png');
  });

  it('still lands in the note that asked for it when nothing moved', async () => {
    const save = deferred<string>();
    fsMock.saveImagePath.mockReturnValue(save.promise);

    handle.openNote('note A body');
    dropPath('/pics/holiday.png');

    save.resolve('image-holiday.png');
    await settle();

    expect(handle.getContent()).toContain('![](image-holiday.png)');
    expect(fsMock.deleteFile).not.toHaveBeenCalled();
  });

  /* The paste door, which reaches the same completion through a different
   * seam (`imagePasteSink.ts`) — M17: the guard has to be on both, not just
   * the one the bug was reported against. */
  it('does not let a pasted image reach the note the user moved on to', async () => {
    const save = deferred<string>();
    fsMock.saveImageBytes.mockReturnValue(save.promise);

    handle.openNote('note A body');
    pasteImage();

    handle.openNote('note B body');
    save.resolve('image-pasted.png');
    await settle();

    const content = handle.getContent();
    expect(content).toContain('note B body');
    expect(content).not.toContain('![](');
    await vi.waitFor(() => expect(fsMock.deleteFile).toHaveBeenCalledWith('image-pasted.png'));
  });

  it('still lands a pasted image in the note that asked for it', async () => {
    const save = deferred<string>();
    fsMock.saveImageBytes.mockReturnValue(save.promise);

    handle.openNote('note A body');
    pasteImage();

    save.resolve('image-pasted.png');
    await settle();

    expect(handle.getContent()).toContain('![](image-pasted.png)');
    expect(fsMock.deleteFile).not.toHaveBeenCalled();
  });
});
