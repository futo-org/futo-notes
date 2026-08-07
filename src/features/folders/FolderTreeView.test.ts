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

// A note switch dirties layout, and WebKit then lays out every mounted row —
// ~125 ms of a ~148 ms Ctrl+Tab at 2,533 rows, which CSS containment does not
// avoid. Only mounting the visible window removes that work, so the row count
// is the thing worth locking. → docs/perf/tab-switch-baseline.md
describe('FolderTreeView virtualization', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;
  let clientHeight: ReturnType<typeof vi.spyOn> | null = null;

  // jsdom does no layout, so the component can only see a viewport if we give
  // it one. Rows keep offsetTop 0, so the component falls back to its declared
  // row pitch — which is what makes the expected window size predictable here.
  const VIEWPORT_PX = 400;
  const ROW_PITCH = 49;
  const OVERSCAN = 8;

  function rowCount(): number {
    return target.querySelectorAll('.note-row, .folder-row, .folder-empty-row').length;
  }

  function mountWithViewport(items: NotePreview[], viewport: number | null) {
    if (viewport !== null) {
      clientHeight = vi
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.classList.contains('folder-tree-scroll') ? viewport : 0;
        });
    }
    app = mount(FolderTreeView, { target, props: { items } });
    flushSync();
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
    clientHeight?.mockRestore();
    clientHeight = null;
    target.remove();
  });

  it('mounts only the visible window, not every row', () => {
    const items = Array.from({ length: 300 }, (_, i) => note(`note-${String(i).padStart(3, '0')}`));
    mountWithViewport(items, VIEWPORT_PX);

    const expected = Math.ceil(VIEWPORT_PX / ROW_PITCH) + OVERSCAN;
    expect(rowCount()).toBeLessThanOrEqual(expected);
    expect(rowCount()).toBeGreaterThan(0);
    // The pre-virtualization component mounted all 300.
    expect(rowCount()).toBeLessThan(300);
  });

  it('keeps the scrollable height of the full list via spacers', () => {
    const items = Array.from({ length: 300 }, (_, i) => note(`note-${String(i).padStart(3, '0')}`));
    mountWithViewport(items, VIEWPORT_PX);

    const spacers = Array.from(target.querySelectorAll<HTMLElement>('.tree-spacer'));
    const spacerPx = spacers.reduce((sum, el) => sum + parseInt(el.style.height || '0', 10), 0);
    expect(spacerPx + rowCount() * ROW_PITCH).toBe(300 * ROW_PITCH);
  });

  it('renders a different slice after scrolling', () => {
    const items = Array.from({ length: 300 }, (_, i) => note(`note-${String(i).padStart(3, '0')}`));
    mountWithViewport(items, VIEWPORT_PX);
    const firstBefore = target.querySelector('.note-row')?.getAttribute('data-note-id');

    const scroller = target.querySelector('.folder-tree-scroll') as HTMLElement;
    scroller.scrollTop = 150 * ROW_PITCH;
    scroller.dispatchEvent(new Event('scroll'));
    flushSync();

    const firstAfter = target.querySelector('.note-row')?.getAttribute('data-note-id');
    expect(firstAfter).not.toBe(firstBefore);
    expect(firstAfter).toBe('note-142'); // 150 - OVERSCAN
    expect(rowCount()).toBeLessThan(300);
  });

  it('renders every row when no viewport height is measurable', () => {
    // jsdom's default (clientHeight 0) stands in for the frame before the
    // ResizeObserver first reports: guessing a window there would hide rows a
    // caller expects to be present.
    const items = Array.from({ length: 60 }, (_, i) => note(`note-${String(i).padStart(3, '0')}`));
    mountWithViewport(items, null);
    expect(rowCount()).toBe(60);
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
