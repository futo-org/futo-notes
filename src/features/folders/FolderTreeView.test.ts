// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import FolderTreeView from './FolderTreeView.svelte';
import { setFolderSnapshot } from './emptyFolders.svelte';
import { setFolderOpen } from './folderExpansion.svelte';
import type { NotePreview } from '$shared/types/note';

const platformState = vi.hoisted(() => ({ isLinux: false }));
vi.mock('$lib/platform', async (importOriginal) => {
  const mod = await importOriginal<typeof import('$lib/platform')>();
  return {
    ...mod,
    get isLinux() {
      return platformState.isLinux;
    },
  };
});

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

function note(id: string): NotePreview {
  return { id, title: id, preview: '', modificationTime: 0, tags: [] };
}

describe('FolderTreeView per-folder empty state', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(async () => {
    if (app) {
      unmount(app);
      app = null;
    }
    target.remove();
    setFolderOpen('Empty', false);
    setFolderSnapshot([], []);
  });

  it('shows "Nothing here yet" inside an expanded empty folder', async () => {
    setFolderSnapshot(['Empty'], []);
    setFolderOpen('Empty', true);

    app = mount(FolderTreeView, { target, props: { items: [] } });
    flushSync();

    const placeholder = target.querySelector('[data-testid="folder-empty-state"]');
    expect(placeholder).toBeTruthy();
    expect(placeholder?.textContent).toBe('Nothing here yet');
    expect(target.querySelector('.empty-state')).toBeNull();
  });

  it('hides the placeholder when the folder is collapsed', async () => {
    setFolderSnapshot(['Empty'], []);
    setFolderOpen('Empty', false);

    app = mount(FolderTreeView, { target, props: { items: [] } });
    flushSync();

    expect(target.querySelector('[data-testid="folder-empty-state"]')).toBeNull();

    (target.querySelector('.folder-row') as HTMLElement).click();
    flushSync();
    expect(target.querySelector('[data-testid="folder-empty-state"]')?.textContent).toBe(
      'Nothing here yet',
    );
  });

  it('shows no placeholder for an expanded folder with notes', async () => {
    setFolderOpen('Empty', true); // stale open-state for a folder that no longer exists
    app = mount(FolderTreeView, {
      target,
      props: { items: [note('Specs/foo')] },
    });
    flushSync();

    (target.querySelector('.folder-row') as HTMLElement).click(); // open "Specs"
    flushSync();
    expect(target.querySelector('[data-testid="folder-empty-state"]')).toBeNull();
    expect(target.textContent).toContain('foo');
    setFolderOpen('Specs', false);
  });

  it('keeps the whole-vault empty state when there are no notes and no folders', () => {
    app = mount(FolderTreeView, { target, props: { items: [] } });
    flushSync();
    expect(target.querySelector('.empty-state')?.textContent).toContain('No notes yet');
  });
});

describe('FolderTreeView drag image is WebKitGTK-only', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  const NOTE_MIME = 'application/futo-note-id';

  function fakeDataTransfer() {
    const store: Record<string, string> = {};
    return {
      setData: (t: string, v: string) => {
        store[t] = v;
      },
      getData: (t: string) => store[t] ?? '',
      setDragImage: vi.fn(),
      effectAllowed: 'uninitialized',
      dropEffect: 'none',
      get types() {
        return Object.keys(store);
      },
    };
  }

  function fireDrag(el: HTMLElement, type: string, dt: ReturnType<typeof fakeDataTransfer>) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
    el.dispatchEvent(ev);
    return ev;
  }

  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (app) {
      unmount(app);
      app = null;
    }
    target.remove();
    platformState.isLinux = false;
    setFolderOpen('Specs', false);
  });

  it('does NOT mutate the DOM during dragstart on non-Linux (macOS/Windows)', () => {
    platformState.isLinux = false;
    app = mount(FolderTreeView, {
      target,
      props: { items: [note('Specs/foo'), note('welcome')] },
    });
    flushSync();

    const noteRow = target.querySelector('[data-note-id="welcome"]') as HTMLElement;
    const dt = fakeDataTransfer();
    fireDrag(noteRow, 'dragstart', dt);
    flushSync();

    expect(dt.getData(NOTE_MIME)).toBe('welcome');
    expect(dt.effectAllowed).toBe('move');
    expect(dt.setDragImage).not.toHaveBeenCalled();
    expect(document.body.querySelector('canvas')).toBeNull();
    expect(document.body.querySelector(':scope > .note-row')).toBeNull();

    const folderRow = target.querySelector('[data-folder-path="Specs"]') as HTMLElement;
    fireDrag(folderRow, 'dragover', dt);
    flushSync();
    expect(folderRow.classList.contains('drop-target')).toBe(true);
  });

  it('installs the drag-image mirror on Linux (WebKitGTK)', () => {
    platformState.isLinux = true;
    app = mount(FolderTreeView, {
      target,
      props: { items: [note('Specs/foo'), note('welcome')] },
    });
    flushSync();

    const noteRow = target.querySelector('[data-note-id="welcome"]') as HTMLElement;
    const dt = fakeDataTransfer();
    fireDrag(noteRow, 'dragstart', dt);
    flushSync();

    expect(dt.setDragImage).toHaveBeenCalled();
    expect(document.body.querySelector(':scope > .note-row')).not.toBeNull();

    fireDrag(noteRow, 'dragend', dt);
    flushSync();
    expect(document.body.querySelector(':scope > .note-row')).toBeNull();
  });
});
