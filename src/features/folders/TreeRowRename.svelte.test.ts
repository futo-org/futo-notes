// @vitest-environment jsdom
/* The inline rename field commits on Enter and on clicking away, and cancels on Escape. Closing
 * the field removes it, and Chromium (WebView2) blurs a focused element synchronously while it is
 * being removed — inside Svelte's DOM update. That blur is not the user clicking away: crash #1875
 * (2.0.1, Windows) was the old blur handler writing `isSubmitting` from inside that update
 * (`state_unsafe_mutation`). jsdom sends no blur on removal, so `blurOnRemoval` adds Chromium's. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { desktopLocalization, type LocalizedMessage } from '$shared/localization';
import FolderTreeNoteRow from './FolderTreeNoteRow.svelte';

const toasts = vi.hoisted(() => ({ shown: [] as unknown[], onShow: (): void => {} }));
vi.mock('$shared/notifications/toastBus.svelte', () => ({
  showGlobalToast: (message: unknown) => {
    toasts.shown.push(message);
    toasts.onShow();
  },
}));

let target: HTMLDivElement;
let app: ReturnType<typeof mount> | null = null;
let rejections: unknown[] = [];
const recordRejection = (reason: unknown): void => {
  rejections.push(reason);
};
const elementRemove = Element.prototype.remove;

function blurOnRemoval(): void {
  Element.prototype.remove = function (this: Element) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.contains(focused)) focused.blur();
    elementRemove.call(this);
  };
}

function openRename(
  onrename: (id: string, title: string) => LocalizedMessage | null,
): HTMLInputElement {
  app = mount(FolderTreeNoteRow, {
    target,
    props: {
      node: {
        type: 'note',
        note: { id: 'groceries', title: 'groceries', preview: '', modificationTime: 0, tags: [] },
        depth: 0,
        parentPath: '',
      },
      indentPixels: 12,
      selected: false,
      onrename,
      onselect: () => {},
      oncontextmenu: () => {},
      ondragstart: () => {},
      ondragend: () => {},
      ondragover: () => {},
      ondrop: () => {},
    },
  });
  flushSync();
  target
    .querySelector('button.note-row')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  flushSync();
  const input = target.querySelector<HTMLInputElement>('[data-testid="note-rename-input"]')!;
  expect(document.activeElement).toBe(input);
  input.value = 'grocery list';
  input.dispatchEvent(new Event('input'));
  flushSync();
  return input;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  desktopLocalization.setSelectedLanguageTag('en');
  target = document.createElement('div');
  document.body.append(target);
  rejections = [];
  toasts.shown = [];
  toasts.onShow = () => {};
  process.on('unhandledRejection', recordRejection);
  blurOnRemoval();
});

afterEach(() => {
  Element.prototype.remove = elementRemove;
  process.off('unhandledRejection', recordRejection);
  if (app) unmount(app);
  app = null;
  target.remove();
  desktopLocalization.setSelectedLanguageTag(null);
});

it('commits once on Enter, and the field closing behind it commits nothing more', async () => {
  const onrename = vi.fn(() => null);
  const input = openRename(onrename);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  flushSync();
  await settle();
  expect(target.querySelector('[data-testid="note-rename-input"]')).toBeNull();
  expect(onrename).toHaveBeenCalledExactlyOnceWith('groceries', 'grocery list');
  expect(rejections).toEqual([]);
});

it('commits nothing on Escape, though closing the field blurs it', async () => {
  const onrename = vi.fn(() => null);
  const input = openRename(onrename);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  await settle();
  expect(target.querySelector('[data-testid="note-rename-input"]')).toBeNull();
  expect(onrename).not.toHaveBeenCalled();
  expect(rejections).toEqual([]);
});

it('commits once when the user clicks away', async () => {
  const onrename = vi.fn(() => null);
  const input = openRename(onrename);
  input.blur();
  await settle();
  flushSync();
  await settle();
  expect(target.querySelector('[data-testid="note-rename-input"]')).toBeNull();
  expect(onrename).toHaveBeenCalledExactlyOnceWith('groceries', 'grocery list');
  expect(rejections).toEqual([]);
});

it('a blur while a rename is in flight starts no second one, even when the rename settles at once', async () => {
  const failure: LocalizedMessage = { path: 'notes.title.duplicate' };
  const onrename = vi.fn(() => failure);
  const input = openRename(onrename);
  // One blur lands while the rejection is being reported: still in flight, settled a moment later.
  toasts.onShow = () => {
    toasts.onShow = () => {};
    input.dispatchEvent(new FocusEvent('blur'));
  };
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  flushSync();
  await settle();
  expect(onrename).toHaveBeenCalledExactlyOnceWith('groceries', 'grocery list');
  expect(toasts.shown).toEqual([failure]);
  expect(input.value).toBe('grocery list');
  expect(rejections).toEqual([]);
});
