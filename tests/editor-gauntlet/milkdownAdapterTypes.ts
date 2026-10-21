// The in-page shapes and timing constants the Milkdown gauntlet adapter shares with
// its base class, moved here verbatim from milkdownAdapter.ts.

import type { FakeHostWindow } from '../lib/editorEmbedHost';

/** Milkdown's own change notification is debounced by @milkdown/plugin-listener. */
export const CHANGE_DEBOUNCE_MS = 200;
/** Debounce plus slack, after which a missing `change` is a real finding. */
export const CHANGE_FLUSH_MS = CHANGE_DEBOUNCE_MS + 300;

export interface GauntletPageState {
  /** Captured while the selection is still ProseMirror's post-load TextSelection. */
  TextSelection: {
    create(doc: unknown, anchor: number, head: number): unknown;
  };
}

export type MilkdownWindow = FakeHostWindow & {
  __futoProseMirrorView?: () => ProseViewLike | null;
  __gauntlet?: GauntletPageState;
};

/** The slice of the ProseMirror view surface this adapter uses, in-page. */
export interface ProseViewLike {
  state: {
    doc: ProseNodeLike;
    tr: ProseTransactionLike;
    selection: { constructor: unknown; from: number; to: number };
  };
  dispatch(tr: unknown): void;
  focus(): void;
  posAtDOM(node: Node, offset: number): number;
  nodeDOM(pos: number): Node | null;
  dom: HTMLElement;
}

export interface ProseNodeLike {
  childCount: number;
  content: { size: number };
  nodeSize: number;
  isText: boolean;
  isLeaf: boolean;
  isAtom: boolean;
  text?: string;
  child(index: number): ProseNodeLike;
  resolve(pos: number): unknown;
  nodesBetween(
    from: number,
    to: number,
    callback: (node: ProseNodeLike, pos: number) => boolean | void,
  ): void;
}

export interface ProseTransactionLike {
  setSelection(selection: unknown): ProseTransactionLike;
  insertText(text: string, from?: number, to?: number): ProseTransactionLike;
}

/**
 * A caret target expressed the way the candidate can resolve it: either the nth
 * rendered character of the nth top-level block (from a markdown source
 * offset), or an offset into a named run of rendered text (from a case's
 * `rich` anchor, which is exact).
 */
export type CaretPoint =
  | { kind: 'block'; blockIndex: number; textOffset: number }
  | { kind: 'text'; text: string; offset: number; atom?: 'before' | 'after' };
