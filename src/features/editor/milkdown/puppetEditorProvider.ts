import { serializerCtx, type Editor } from '@milkdown/kit/core';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { PuppetEditorProvider } from '$app/puppet/puppetRegistry';
import type { ImageInserter } from '../imageInsert';
import { getFindState, scanFindResults } from './find/findPlugin';
import { parseNote } from './parseNote';

/** The view this editor lends to the puppet inspector (dev and opted-in builds). */
export function createPuppetEditorProvider(deps: {
  pmView: () => ProseView | null;
  loading: () => boolean;
  note: () => string | null;
  getEditor: () => Editor | null;
  execIds: () => string[];
  exec: (commandId: string) => boolean;
  openFind: () => void;
  openLinkElement: (element: HTMLElement | null, newTab: boolean) => boolean;
  imageInserter: ImageInserter;
}): PuppetEditorProvider {
  const { pmView, getEditor, exec, openFind, openLinkElement, imageInserter } = deps;

  /** The element a link or chip at document position `pos` renders as. */
  function linkElementAt(pos: number): HTMLElement | null {
    const view = pmView();
    if (!view || pos < 0 || pos >= view.state.doc.content.size) return null;
    const node = view.state.doc.nodeAt(pos);
    if (node && !node.isText) {
      const dom = view.nodeDOM(pos);
      return dom instanceof HTMLElement ? dom : null;
    }
    const { node: dom } = view.domAtPos(pos + 1);
    return dom instanceof HTMLElement ? dom : dom.parentElement;
  }

  return {
    getView: pmView,
    loading: deps.loading,
    note: deps.note,
    find: () => {
      const view = pmView();
      if (!view) return { open: false, query: '', current: 0, total: 0 };
      // The count is a frame behind a query change; a receipt must already carry it.
      const pending = getFindState(view.state);
      if (pending.open && pending.scanPending) scanFindResults(view, pending.pendingSelect);
      const find = getFindState(view.state);
      return {
        open: find.open,
        query: find.query,
        current: find.matches.length > 0 ? find.currentIndex + 1 : 0,
        total: find.matches.length,
      };
    },
    execIds: () => deps.execIds().filter((id) => id !== 'undo' && id !== 'redo'),
    exec: (commandId) => void exec(commandId),
    openFind,
    parseMarkdown: (markdown) => {
      const editor = getEditor();
      return editor ? parseNote(editor, markdown) : null;
    },
    serialize: (doc) => {
      try {
        return getEditor()?.ctx.get(serializerCtx)(doc) ?? null;
      } catch {
        return null;
      }
    },
    openLinkAt: (pos, newTab) => openLinkElement(linkElementAt(pos), newTab),
    ...(imageInserter.canPick ? { insertImage: (path: string) => imageInserter.pick([path]) } : {}),
  };
}
