// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import FolderTreeView from './FolderTreeView.svelte';
import { refreshEmptyFolders, setFolderOpen } from '$lib/folders.svelte';
import type { NotePreview } from '../types';

// The empty-folder set is refreshed from the platform FS. Stub only
// getFS so `refreshEmptyFolders` can report folders that exist on disk
// without notes; everything else keeps the real (web) implementation.
const fsState = vi.hoisted(() => ({ folders: [] as { path: string }[] }));
// Flip per-test to exercise the platform-gated drag-image hack (Linux only).
const platformState = vi.hoisted(() => ({ isLinux: false }));
vi.mock('$lib/platform', async (importOriginal) => {
  const mod = await importOriginal<typeof import('$lib/platform')>();
  return {
    ...mod,
    get isLinux() {
      return platformState.isLinux;
    },
    getFS: () => ({ listFolders: async () => fsState.folders }),
  };
});

// jsdom has no ResizeObserver; the tree observes its scroll container
// for virtualization. A no-op stub keeps the initial-render fallback
// path (first ~40 rows) active, which is all these tests need.
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
    // Reset module-level folder state so tests can't leak into each other.
    setFolderOpen('Empty', false);
    fsState.folders = [];
    await refreshEmptyFolders([]);
  });

  // Regression (QA 2026-07-02): expanding a freshly-created empty folder
  // rendered nothing — the only empty state was the whole-vault one at
  // flat.length === 0. Spec list.md: "An empty folder shows an empty
  // state" ("Nothing here yet" on Tauri).
  it('shows "Nothing here yet" inside an expanded empty folder', async () => {
    fsState.folders = [{ path: 'Empty' }];
    await refreshEmptyFolders([]);
    setFolderOpen('Empty', true);

    app = mount(FolderTreeView, { target, props: { items: [] } });
    flushSync();

    const placeholder = target.querySelector('[data-testid="folder-empty-state"]');
    expect(placeholder).toBeTruthy();
    expect(placeholder?.textContent).toBe('Nothing here yet');
    // The whole-vault empty state must NOT show — the vault has a folder.
    expect(target.querySelector('.empty-state')).toBeNull();
  });

  it('hides the placeholder when the folder is collapsed', async () => {
    fsState.folders = [{ path: 'Empty' }];
    await refreshEmptyFolders([]);
    setFolderOpen('Empty', false);

    app = mount(FolderTreeView, { target, props: { items: [] } });
    flushSync();

    expect(target.querySelector('[data-testid="folder-empty-state"]')).toBeNull();

    // Expanding via the folder row reveals it.
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

// Regression (2026-07-08, macOS): dragging a note onto a folder silently
// failed on the desktop app. `setControlledDragImage` mutated the DOM during
// `dragstart` (appended a 1×1 canvas + a cloned mirror to <body>, called
// setDragImage), which WebKitGTK tolerates but macOS WKWebView does not — it
// aborts the drag immediately (dragstart → dragend, zero dragover), so no
// folder highlights and drops never land. The hack is now gated to Linux.
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

    // The drag still initializes (data + effect are set) …
    expect(dt.getData(NOTE_MIME)).toBe('welcome');
    expect(dt.effectAllowed).toBe('move');
    // … but the WebKitGTK-only image hack must be inert: no setDragImage,
    // no stray canvas, no floating mirror appended to <body>. Any of these
    // is what aborts the drag on WKWebView.
    expect(dt.setDragImage).not.toHaveBeenCalled();
    expect(document.body.querySelector('canvas')).toBeNull();
    expect(document.body.querySelector(':scope > .note-row')).toBeNull();

    // And the drop path is live: hovering a folder marks it as the target.
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

    // dragend tears the mirror back down so it can't leak into other tests.
    fireDrag(noteRow, 'dragend', dt);
    flushSync();
    expect(document.body.querySelector(':scope > .note-row')).toBeNull();
  });
});
