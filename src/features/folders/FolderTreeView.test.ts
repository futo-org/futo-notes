// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import FolderTreeView from './FolderTreeView.svelte';
import { setFolderSnapshot } from './emptyFolders.svelte';
import { isFolderOpen, setFolderOpen } from './folderExpansion.svelte';
import type { NotePreview } from '$shared/types/note';
import { runPuppetCommand } from '$app/puppet/puppetInspector';
import { clearPuppetVerbs, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
import { collectElements } from '$app/puppet/puppetElements';

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

function notes(count: number): NotePreview[] {
  return Array.from({ length: count }, (_, i) => note(`note-${String(i).padStart(3, '0')}`));
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

  it('shows no placeholder for an expanded folder with notes', async () => {
    setFolderOpen('Empty', true); // stale open-state for a folder that no longer exists
    app = mount(FolderTreeView, {
      target,
      props: { items: [note('Specs/foo')] },
    });
    flushSync();

    (target.querySelector('.folder-row') as HTMLElement).click(); // open "Specs"
    flushSync();
    expect(target.querySelector('.folder-empty-row')).toBeNull();
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
// These mount up to 600 rows on purpose. Locally each takes ~55 ms; on the shared
// CI runner with three pipelines in flight they took 5.4 s and tripped the 5 s
// default (pc_fdd571c1ceb2). The budget is CPU starvation, not logic.
describe('FolderTreeView virtualization', { timeout: 30_000 }, () => {
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
    mountWithViewport(notes(300), VIEWPORT_PX);

    const expected = Math.ceil(VIEWPORT_PX / ROW_PITCH) + OVERSCAN;
    expect(rowCount()).toBeLessThanOrEqual(expected);
    expect(rowCount()).toBeGreaterThan(0);
    // The pre-virtualization component mounted all 300.
    expect(rowCount()).toBeLessThan(300);
  });

  it('keeps the scrollable height of the full list via spacers', () => {
    mountWithViewport(notes(300), VIEWPORT_PX);

    const spacers = Array.from(target.querySelectorAll<HTMLElement>('.tree-spacer'));
    const spacerPx = spacers.reduce((sum, el) => sum + parseInt(el.style.height || '0', 10), 0);
    expect(spacerPx + rowCount() * ROW_PITCH).toBe(300 * ROW_PITCH);
  });

  it('renders a different slice after scrolling', () => {
    mountWithViewport(notes(300), VIEWPORT_PX);
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

  it('mounts the destination slice inside the scroll event before WebKit can paint a gap', () => {
    mountWithViewport(notes(300), VIEWPORT_PX);

    const scroller = target.querySelector('.folder-tree-scroll') as HTMLElement;
    let firstIdDuringScroll: string | null = null;
    // Registered after the component's own handler, so it observes the DOM as
    // it stands when the scroll event finishes dispatching — i.e. what WebKit
    // could paint next.
    scroller.addEventListener('scroll', () => {
      firstIdDuringScroll = target.querySelector('.note-row')?.getAttribute('data-note-id') ?? null;
    });

    scroller.scrollTop = 150 * ROW_PITCH;
    scroller.dispatchEvent(new Event('scroll'));

    expect(firstIdDuringScroll).toBe('note-142');
  });

  // WebKit scrolls the container on its own thread and can paint an offset
  // before the main thread is told about it. 8 rows of overscan cover ~390px
  // while a measured fling moves 1,000-5,500px per scroll notification, so the
  // painted viewport lands on the spacer and the sidebar goes blank. The window
  // therefore has to lead the scroll. Ground truth for these numbers (native
  // window captures, not rAF sampling): docs/perf/tab-switch-baseline.md.
  it('leads the mounted window past the viewport in the direction of travel', () => {
    mountWithViewport(notes(600), VIEWPORT_PX);

    const scroller = target.querySelector('.folder-tree-scroll') as HTMLElement;
    scroller.scrollTop = 150 * ROW_PITCH; // a 150-row jump, as a fling produces
    scroller.dispatchEvent(new Event('scroll'));
    flushSync();

    // The last row the viewport itself shows is ~159; without a lead the window
    // ended 8 rows later, so a frame painted further down had nothing to show.
    expect(target.querySelector('[data-note-id="note-250"]')).toBeTruthy();
    // Still bounded: the lead is capped, so a jump can never mount everything.
    expect(rowCount()).toBeLessThanOrEqual(Math.ceil(VIEWPORT_PX / ROW_PITCH) + 2 * OVERSCAN + 128);
  });

  it('leads upward when the scroll travels up', () => {
    mountWithViewport(notes(600), VIEWPORT_PX);
    const scroller = target.querySelector('.folder-tree-scroll') as HTMLElement;
    scroller.scrollTop = 300 * ROW_PITCH;
    scroller.dispatchEvent(new Event('scroll'));
    flushSync();

    scroller.scrollTop = 150 * ROW_PITCH;
    scroller.dispatchEvent(new Event('scroll'));
    flushSync();

    expect(target.querySelector('[data-note-id="note-050"]')).toBeTruthy();
    expect(rowCount()).toBeLessThanOrEqual(Math.ceil(VIEWPORT_PX / ROW_PITCH) + 2 * OVERSCAN + 128);
  });

  it('collapses back to the cheap window once scrolling settles', () => {
    vi.useFakeTimers();
    try {
      mountWithViewport(notes(600), VIEWPORT_PX);
      const scroller = target.querySelector('.folder-tree-scroll') as HTMLElement;
      scroller.scrollTop = 150 * ROW_PITCH;
      scroller.dispatchEvent(new Event('scroll'));
      flushSync();
      expect(rowCount()).toBeGreaterThan(Math.ceil(VIEWPORT_PX / ROW_PITCH) + 2 * OVERSCAN);

      // A note switch must not pay for the fling's extra rows: that is the whole
      // point of virtualizing the tree.
      vi.advanceTimersByTime(200);
      flushSync();
      expect(rowCount()).toBeLessThanOrEqual(Math.ceil(VIEWPORT_PX / ROW_PITCH) + 2 * OVERSCAN);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ScrollToRow brings a row below the fold on screen and answers once it has landed', async () => {
    const items = Array.from({ length: 300 }, (_, i) => note(`note-${String(i).padStart(3, '0')}`));
    mountWithViewport(items, VIEWPORT_PX);
    const scroller = target.querySelector<HTMLElement>('.folder-tree-scroll')!;
    expect(target.querySelector('[data-note-id="note-250"]')).toBeNull();

    const reply = runPuppetCommand('do', { verb: 'ScrollToRow', args: { noteId: 'note-250' } });

    expect(scroller.scrollTop).toBe(251 * ROW_PITCH - VIEWPORT_PX);
    // The receipt waits for the browser's own scroll event (puppetScroll.ts scrollLanded),
    // whose handler mounts the row.
    expect(reply.status).toBe(202);
    scroller.dispatchEvent(new Event('scroll'));
    flushSync();
    expect(target.querySelector('[data-note-id="note-250"]')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const action = (reply.body as { action: number }).action;
    expect(runPuppetCommand('diff', { action }).body).not.toMatchObject({ pending: true });
  });

  it('ScrollToRow answers at once when the row is already on screen', () => {
    const items = Array.from({ length: 300 }, (_, i) => note(`note-${String(i).padStart(3, '0')}`));
    mountWithViewport(items, VIEWPORT_PX);
    expect(
      runPuppetCommand('do', { verb: 'ScrollToRow', args: { noteId: 'note-001' } }).status,
    ).toBe(200);
  });

  it('renders every row when no viewport height is measurable', () => {
    // jsdom's default (clientHeight 0) stands in for the frame before the
    // ResizeObserver first reports: guessing a window there would hide rows a
    // caller expects to be present.
    mountWithViewport(notes(60), null);
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

// A folder inside a collapsed parent is in the vault, so the folder verbs take it as the note
// verbs take a note there: once every folder verb refused it `400 no such folder`.
describe('FolderTreeView puppet verbs', () => {
  const VAULT = [note('reading/articles/one'), note('personal/family/gifts'), note('inbox/idea')];
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  const doVerb = (verb: string, args: Record<string, unknown>) =>
    runPuppetCommand('do', { verb, args });

  function mountTree(props: Record<string, unknown> = {}) {
    app = mount(FolderTreeView, { target, props: { items: VAULT, ...props } });
    flushSync();
  }

  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    clearPuppetVerbs();
    target.remove();
    for (const path of ['reading', 'reading/articles', 'personal', 'personal/family', 'inbox']) {
      setFolderOpen(path, false);
    }
  });

  it('a drop takes its target by path, and refuses one that does not exist', () => {
    const movedNote = vi.fn();
    const movedFolder = vi.fn();
    mountTree({ ondropnoteonfolder: movedNote, ondropfolderonfolder: movedFolder });

    expect(doVerb('MoveNote', { noteId: 'inbox/idea', targetPath: 'personal/family' }).status).toBe(
      200,
    );
    expect(movedNote).toHaveBeenCalledWith('inbox/idea', 'personal/family');
    expect(
      doVerb('MoveFolder', { path: 'personal/family', targetPath: 'reading/articles' }).status,
    ).toBe(200);
    expect(movedFolder).toHaveBeenCalledWith('personal/family', 'reading/articles');
    expect(doVerb('MoveFolder', { path: 'reading/nothing', targetPath: '' })).toMatchObject({
      status: 400,
      body: { error: 'no such folder: reading/nothing' },
    });
  });

  it('a move answers once it has landed, so the next verb sees the moved note', async () => {
    // tidy-work: `MoveNote work/standup → ""` answered 200, then a rename of the new id
    // refused `no such note` because the note list had not been updated yet.
    const landings: Array<() => void> = [];
    const pending = () => new Promise<void>((resolve) => landings.push(resolve));
    mountTree({ ondropnoteonroot: pending, ondropfolderonfolder: pending });

    const actionOf = (receipt: { status: number; body: unknown }) => {
      expect(receipt.status).toBe(202);
      return (receipt.body as { action: number }).action;
    };
    const moves = [
      actionOf(doVerb('MoveNote', { noteId: 'inbox/idea', targetPath: '' })),
      actionOf(doVerb('MoveFolder', { path: 'inbox', targetPath: 'reading' })),
    ];
    for (const [index, action] of moves.entries()) {
      await Promise.resolve();
      expect(runPuppetCommand('diff', { action }).body).toMatchObject({ pending: true });
      landings[index]();
      await vi.waitFor(() =>
        expect(runPuppetCommand('diff', { action }).body).toMatchObject({ status: 200 }),
      );
    }
  });

  it('ScrollToRow refuses a row a collapsed folder hides, as no scroll would show it', () => {
    mountTree();
    expect(doVerb('ScrollToRow', { noteId: 'reading/articles/one' })).toMatchObject({
      status: 409,
      body: { error: 'reading/articles/one has no row: a folder above it is collapsed' },
    });
    expect(doVerb('ScrollToRow', {}).status).toBe(400);
  });

  it('a row reads the verb its click runs: ToggleFolder on a folder, OpenNote on a note', () => {
    setFolderOpen('inbox', true);
    mountTree();
    // NotesShell's OpenNote, declared as it is there.
    registerPuppetVerbs(() => [
      puppetVerb('OpenNote', { noteId: 'string' }, () => {}, {
        controlsMatching: '[data-note-id]',
      }),
    ]);
    const rows = collectElements({ all: true });
    expect(rows.find((row) => row.note === 'inbox/idea')?.verb).toBe('OpenNote');
    expect(rows.find((row) => row.folder === 'reading')?.verb).toBe('ToggleFolder');
  });

  it('a toggle or a context menu acts on a row whose parents are open', () => {
    const folderMenu = vi.fn();
    const noteMenu = vi.fn();
    mountTree({ onfoldercontextmenu: folderMenu, onnotecontextmenu: noteMenu });

    expect(doVerb('ToggleFolder', { path: 'personal' }).status).toBe(200);
    expect(doVerb('ToggleFolder', { path: 'personal/family' }).status).toBe(200);
    expect(isFolderOpen('personal/family')).toBe(true);
    flushSync();
    expect(target.textContent).toContain('gifts');

    expect(doVerb('OpenFolderContextMenu', { path: 'reading' }).status).toBe(200);
    expect(folderMenu).toHaveBeenCalledWith('reading', 0, 0);
    expect(doVerb('OpenNoteContextMenu', { noteId: 'personal/family/gifts' }).status).toBe(200);
    expect(noteMenu).toHaveBeenCalledWith('personal/family/gifts', 0, 0);
  });
});
