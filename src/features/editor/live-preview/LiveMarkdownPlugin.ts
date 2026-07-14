import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';

import { createLiveMarkdownDecorationBuilder } from './buildLiveMarkdownDecorations';
import { imageCacheUpdated } from './images';
import { liveMarkdownRefresh } from './refreshEffect';

export class LiveMarkdownPlugin implements PluginValue {
  decorations: DecorationSet = Decoration.none;
  private lastTreeLength = 0;
  private lastCursorLine = -1;
  private lastCursorPosition = -1;
  private isCompositionSuspended = false;
  private pendingRefresh: ReturnType<typeof setTimeout> | null = null;
  private isDestroyed = false;
  private readonly buildDecorations = createLiveMarkdownDecorationBuilder();

  constructor(view: EditorView) {
    ensureSyntaxTree(view.state, view.state.doc.length, 200);
    this.lastTreeLength = syntaxTree(view.state).length;
    this.decorations = this.buildDecorations(view);
    this.lastCursorPosition = view.state.selection.main.head;
    this.lastCursorLine = view.state.doc.lineAt(this.lastCursorPosition).number;
    this.scheduleParseRefresh(view);
  }

  update(update: ViewUpdate): void {
    if (update.view.composing || update.view.compositionStarted) {
      this.suspendForComposition(update);
      return;
    }
    if (this.isCompositionSuspended) {
      this.resumeAfterComposition(update);
      return;
    }

    const tree = syntaxTree(update.state);
    const didTreeGrow = tree.length > this.lastTreeLength;
    const didImageCacheChange = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(imageCacheUpdated)),
    );
    const wasRefreshRequested = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(liveMarkdownRefresh)),
    );
    if (didTreeGrow) this.lastTreeLength = tree.length;

    const { didCursorLineChange, didSelectionMoveWithinLine } = this.trackSelection(update);
    const shouldRebuild =
      update.docChanged ||
      didCursorLineChange ||
      didSelectionMoveWithinLine ||
      update.focusChanged ||
      didTreeGrow ||
      didImageCacheChange ||
      wasRefreshRequested;
    if (shouldRebuild) {
      this.decorations = this.buildDecorations(update.view);
      this.scheduleParseRefresh(update.view);
    }
  }

  private suspendForComposition(update: ViewUpdate): void {
    this.isCompositionSuspended = true;
    if (!update.docChanged) return;
    this.decorations = this.decorations.map(update.changes);
    const doc = update.state.doc;
    this.decorations = this.decorations.update({
      filter: (from, to, value) => !value.point || from === to || to <= doc.lineAt(from).to,
    });
  }

  private resumeAfterComposition(update: ViewUpdate): void {
    this.isCompositionSuspended = false;
    this.decorations = this.buildDecorations(update.view);
    this.lastTreeLength = syntaxTree(update.state).length;
    this.lastCursorPosition = update.state.selection.main.head;
    this.lastCursorLine = update.state.doc.lineAt(this.lastCursorPosition).number;
  }

  private trackSelection(update: ViewUpdate): {
    didCursorLineChange: boolean;
    didSelectionMoveWithinLine: boolean;
  } {
    if (!update.selectionSet) {
      return { didCursorLineChange: false, didSelectionMoveWithinLine: false };
    }

    const cursorPosition = update.state.selection.main.head;
    const cursorLine = update.state.doc.lineAt(cursorPosition).number;
    const didCursorLineChange = cursorLine !== this.lastCursorLine;
    const didSelectionMoveWithinLine =
      !didCursorLineChange && !update.docChanged && cursorPosition !== this.lastCursorPosition;
    this.lastCursorLine = cursorLine;
    this.lastCursorPosition = cursorPosition;
    return { didCursorLineChange, didSelectionMoveWithinLine };
  }

  private scheduleParseRefresh(view: EditorView): void {
    if (this.pendingRefresh !== null) clearTimeout(this.pendingRefresh);
    this.pendingRefresh = null;
    if (view.composing || view.compositionStarted || view.state.doc.length === 0) return;
    if (syntaxTree(view.state).length >= view.state.doc.length) return;

    this.pendingRefresh = setTimeout(() => {
      this.pendingRefresh = null;
      if (this.isDestroyed) return;
      ensureSyntaxTree(view.state, view.state.doc.length, 200);
      view.dispatch({ effects: liveMarkdownRefresh.of(null) });
    }, 16);
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.pendingRefresh !== null) clearTimeout(this.pendingRefresh);
    this.pendingRefresh = null;
  }
}
