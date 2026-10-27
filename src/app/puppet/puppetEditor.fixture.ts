// The real editor (MilkdownEditor.svelte), mounted and registered as the puppet's, for the
// puppet tests that drive one: every test starts with no editor, shell or verbs. A test file
// using it mocks `$lib/platform` itself (vi.mock only hoists in a test file):
//
//   vi.mock('$lib/platform', async (importOriginal) => ({
//     ...(await importOriginal<Record<string, unknown>>()), hasFileSystem: true, onFileDrop: () => () => {},
//   }));
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { mount, unmount } from 'svelte';
import { afterEach, beforeAll, expect, vi } from 'vitest';

import { guardEditorTimers } from '../../features/editor/milkdown/__fixtures__/editorTimerGuard';
import { withoutLeakedCtxTimers } from '../../features/editor/milkdown/__fixtures__/noLeakedCtxTimers';
import type { EditorLinkGesture } from '../../features/editor/editorLinkGesture';
import { puppetProviders, clearPuppetVerbs } from './puppetRegistry';

// RC-66: no native timer may outlive a test (see the guard's header).
guardEditorTimers();

const DOC = 'the quick brown fox\n\nsecond line\n';

interface EditorHandle {
  openNote(noteId: string | null, text: string): void;
  getContent(): string | undefined;
}

interface MountedEditor {
  view: EditorView;
  /** The note as the editor would save it now. */
  markdown(): string;
  /** What a click on a wikilink or a URL asked the shell to open. */
  openedNotes: Array<{ title: string; gesture: EditorLinkGesture }>;
  openedUrls: string[];
}

// Once per file: the Milkdown graph is expensive to import (MilkdownEditor.test.ts's header).
const MilkdownEditor = (await import('../../features/editor/milkdown/MilkdownEditor.svelte'))
  .default;

const mounted: Array<ReturnType<typeof mount>> = [];

async function unmountAll(): Promise<void> {
  for (const component of mounted.splice(0)) await unmount(component);
  puppetProviders.editor = null;
  // A null hit everywhere would read as every row covered (puppetElements `hitVersusPaint`).
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
}

beforeAll(() => {
  // jsdom lays nothing out; ProseMirror's scrollIntoView and coordsAtPos measure ranges.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

/**
 * Where each row the editor draws starts, as the screen draws them and not as the puppet
 * counts lines: a textblock, the text after a line break, a code line, a leaf block.
 */
function rowStarts(doc: ProseNode): number[] {
  const starts: number[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.isTextblock) starts.push(pos + 1);
    else if (node.isBlock && node.isLeaf) starts.push(pos);
    else if (node.type.name === 'hardbreak') starts.push(pos + 1);
    else if (node.isText && parent?.type.spec.code) {
      for (let at = node.text!.indexOf('\n'); at !== -1; at = node.text!.indexOf('\n', at + 1)) {
        starts.push(pos + at + 1);
      }
    }
  });
  return starts;
}

/**
 * jsdom paints nothing, so a test gives the editor a layout: one pixel row per row the editor
 * draws, in a scroller `rows` px tall scrolled to put row `first` at its top — all of them by
 * default. The puppet reads a note only where it is on screen (puppetNoteLines.ts
 * `linesOnScreen`), and ScrollToLine scrolls the scroller.
 */
export function layOutLines(view: EditorView, { first = 1, rows = 500 } = {}): void {
  const scroller = view.dom.parentElement!;
  scroller.style.overflowY = 'auto';
  scroller.scrollTop = first - 1;
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, rows);
  view.dom.getBoundingClientRect = () => new DOMRect(0, -scroller.scrollTop, 800, 1e6);
  view.coordsAtPos = (pos: number) => {
    const starts = rowStarts(view.state.doc);
    const row = starts.filter((start) => start <= pos).length;
    const top = Math.max(row, 1) - 1 - scroller.scrollTop;
    return { left: 0, right: 1, top, bottom: top + 1 };
  };
}

/** The editor holding `doc`, replacing any this test mounted before. */
export async function mountEditor(doc = DOC): Promise<MountedEditor> {
  await unmountAll();
  const target = document.createElement('div');
  document.body.appendChild(target);
  // jsdom has no elementFromPoint; @milkdown/plugin-block's hover path calls it.
  (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;
  const openedNotes: MountedEditor['openedNotes'] = [];
  const openedUrls: string[] = [];
  const handle = await withoutLeakedCtxTimers(async () => {
    const component = mount(MilkdownEditor, {
      target,
      props: {
        content: '',
        onchange: () => {},
        onopenlink: (title: string, gesture: EditorLinkGesture) =>
          openedNotes.push({ title, gesture }),
        onopenurl: (url: string) => openedUrls.push(url),
      },
    });
    mounted.push(component);
    await vi.waitFor(() => expect(puppetProviders.editor?.getView()).toBeTruthy(), {
      timeout: 30_000,
    });
    return component as unknown as EditorHandle;
  });
  handle.openNote('fixture', doc);
  const view = puppetProviders.editor!.getView()!;
  layOutLines(view);
  return {
    view,
    markdown: () => handle.getContent() ?? '',
    openedNotes,
    openedUrls,
  };
}

afterEach(async () => {
  await unmountAll();
  puppetProviders.shell = null;
  clearPuppetVerbs();
  document.body.innerHTML = '';
});
