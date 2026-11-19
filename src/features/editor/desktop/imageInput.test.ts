// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PickedImage } from '$lib/platform/types';
import { mountView } from './__test__/mountView';

const { getFS } = vi.hoisted(() => ({ getFS: vi.fn() }));
vi.mock('$lib/platform', () => ({
  getFS,
  getPlatformFS: async () => getFS(),
  onFileDrop: () => () => {},
}));

let saved = 0;
const vault = {
  saveImageBytes: vi.fn(async () => `image-${++saved}.png`),
  getImageUrl: vi.fn(async (filename: string) => `asset://${filename}`),
  saveImagePath: vi.fn(async () => `image-${++saved}.png`),
  deleteFile: vi.fn(async () => {}),
  pickImages: vi.fn(async (): Promise<PickedImage[]> => [
    { bytes: new ArrayBuffer(4), extension: 'png' },
  ]),
};

beforeEach(() => {
  saved = 0;
  vi.clearAllMocks();
  getFS.mockReturnValue(vault);
  // A drawn picture waits to come near the pane; jsdom has no IntersectionObserver.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function png(name = 'photo.png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
}

/** What a paste or a drop carries, as the editor reads it. */
function transfer(data: Record<string, string>, files: File[] = []): DataTransfer {
  const items = files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file }));
  return {
    types: [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])],
    items: Object.assign(items, { length: items.length }),
    files,
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

function paste(target: HTMLElement, data: DataTransfer): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  target.dispatchEvent(event);
  return event;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

it('saves a pasted image file and writes its reference at the caret, text beside it or not', async () => {
  const { view, engine } = await mountView('ab');
  view.selection.selectRange(1, 1);
  const event = paste(view.dom, transfer({ 'text/plain': 'photo.png' }, [png()]));
  expect(event.defaultPrevented).toBe(true);
  // On a line with text the engine gives the image a line of its own (portable-core/images.md).
  await vi.waitFor(() => expect(engine.draftText()).toBe('a\n![](image-1.png)\nb'));
  expect(vault.saveImageBytes).toHaveBeenCalledOnce();
  view.destroy();
  engine.free();
});

it('pastes plain text as Markdown when no image comes with it', async () => {
  const { view, engine } = await mountView('ab');
  view.selection.selectRange(2, 2);
  paste(view.dom, transfer({ 'text/plain': ' **c**', 'text/html': '<b>c</b>' }));
  expect(engine.draftText()).toBe('ab **c**');
  await settled();
  expect(vault.saveImageBytes).not.toHaveBeenCalled();
  view.destroy();
  engine.free();
});

function drop(target: HTMLElement, data: DataTransfer): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: data });
  target.dispatchEvent(event);
  return event;
}

it('writes dropped images where the drop points, in the order dropped', async () => {
  const { view, engine } = await mountView('ab');
  // jsdom lays nothing out: the drop point is at display offset 1.
  view.hitTest.offsetAt = () => ({ offset: 1, rowEnd: false });
  const event = drop(view.dom, transfer({}, [png('one.png'), png('two.png')]));
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() =>
    expect(engine.draftText()).toBe('a\n![](image-1.png)\n![](image-2.png)\nb'),
  );
  view.destroy();
  engine.free();
});

it("reads WebKitGTK's dropped paths and saves the file by its path", async () => {
  const { view, engine } = await mountView('ab');
  view.hitTest.offsetAt = () => ({ offset: 2, rowEnd: false });
  const event = drop(view.dom, transfer({ 'text/uri-list': 'file:///home/me/photo%201.png' }));
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(engine.draftText()).toBe('ab\n![](image-1.png)\n'));
  expect(vault.saveImagePath).toHaveBeenCalledWith('/home/me/photo 1.png');
  view.destroy();
  engine.free();
});

it('takes a drop on a read-only note and saves nothing', async () => {
  const { view, engine } = await mountView('ab');
  view.setReadonly(true);
  const event = drop(view.dom, transfer({}, [png()]));
  expect(event.defaultPrevented).toBe(true);
  await settled();
  expect(vault.saveImageBytes).not.toHaveBeenCalled();
  expect(engine.draftText()).toBe('ab');
  view.destroy();
  engine.free();
});

it('claims a dropped file that is not an image and changes nothing', async () => {
  const { view, engine } = await mountView('ab');
  const event = drop(view.dom, transfer({}, [new File(['# x'], 'note.md')]));
  expect(event.defaultPrevented).toBe(true);
  await settled();
  expect(vault.saveImageBytes).not.toHaveBeenCalled();
  expect(engine.draftText()).toBe('ab');
  view.destroy();
  engine.free();
});

it('accepts an OS file drag over the note, so the window does not refuse it', async () => {
  const { view, engine } = await mountView('ab');
  const event = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], dropEffect: '' } });
  const window = vi.fn();
  document.addEventListener('dragover', window);
  view.dom.dispatchEvent(event);
  document.removeEventListener('dragover', window);
  expect(event.defaultPrevented).toBe(true);
  expect((event as DragEvent).dataTransfer!.dropEffect).toBe('copy');
  expect(window).not.toHaveBeenCalled();
  view.destroy();
  engine.free();
});

it('writes the picked image at the caret, the picker answered by a path or not', async () => {
  const { view, engine } = await mountView('ab');
  view.selection.selectRange(1, 1);
  view.imageInput.pick(['/home/me/photo.png']);
  await vi.waitFor(() => expect(engine.draftText()).toBe('a\n![](image-1.png)\nb'));
  expect(vault.pickImages).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 1, paths: ['/home/me/photo.png'] }),
  );
  expect(vault.saveImageBytes).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'png');
  view.destroy();
  engine.free();
});

it('writes nothing when the picker is cancelled or the note is read-only', async () => {
  const { view, engine } = await mountView('ab');
  vault.pickImages.mockResolvedValueOnce([]);
  view.imageInput.pick();
  await vi.waitFor(() => expect(vault.pickImages).toHaveBeenCalledOnce());
  await settled();
  view.setReadonly(true);
  view.imageInput.pick();
  await settled();
  expect(vault.pickImages).toHaveBeenCalledOnce();
  expect(vault.saveImageBytes).not.toHaveBeenCalled();
  expect(engine.draftText()).toBe('ab');
  view.destroy();
  engine.free();
});
