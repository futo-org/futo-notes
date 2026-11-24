/* For tests: an editor view in jsdom on the real engine, its host's link openings recorded. */
import { vi } from 'vitest';
import { Engine } from '../engine';
import type { LinkOpening } from '../linkPress';
import { EditorView } from '../view';
import { loadEngineBuild } from './loadEngineBuild';

export interface MountedView {
  view: EditorView;
  engine: Engine;
  opened: LinkOpening[];
}

/** A view showing `source`, focused, with the engine holding `noteIds`. */
export async function mountView(source: string, noteIds: string[] = []): Promise<MountedView> {
  await loadEngineBuild();
  // jsdom lays nothing out: a range measures no boxes.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  engine.updateNoteIds(noteIds);
  const wrap = document.createElement('div');
  document.body.append(wrap);
  const opened: LinkOpening[] = [];
  const view = new EditorView(wrap, {
    edited() {},
    focusChanged() {},
    compositionEnded() {},
    toolbar() {},
    copyCode: async () => true,
    openLink: (opening) => opened.push(opening),
    noteId: () => 'mounted note',
  });
  view.open(engine);
  // jsdom focuses no contenteditable element, only one with a tab index.
  view.dom.tabIndex = 0;
  view.focus();
  return { view, engine, opened };
}
