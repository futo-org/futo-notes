import { Decoration, type DecorationSet, type EditorView } from '@codemirror/view';
import type { Range } from '@codemirror/state';

import type { PendingDecoration } from './decorationTypes';
import { shouldRevealMarkdownSyntax } from './selectionReveal';

const MARK_SAFE_WIDGETS = new Set([
  'BulletWidget',
  'NumberWidget',
  'TaskCheckboxWidget',
  'HorizontalRuleWidget',
  'ImageWidget',
  'CodeLanguageLabelWidget',
  'ExternalLinkWidget',
]);

function collectReplaceRanges(
  decorations: PendingDecoration[],
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const decoration of decorations) {
    const { value } = decoration;
    if (value.replace === true && value.widget === undefined && decoration.from < decoration.to) {
      if (!value.wrapInsideMark) ranges.push({ from: decoration.from, to: decoration.to });
      continue;
    }
    if (value.widget && decoration.from < decoration.to) {
      const widgetName = value.widget.constructor?.name ?? '';
      if (!MARK_SAFE_WIDGETS.has(widgetName)) {
        ranges.push({ from: decoration.from, to: decoration.to });
      }
    }
  }
  return ranges.sort((left, right) => left.from - right.from);
}

function clipMark(
  decoration: PendingDecoration,
  replaceRanges: Array<{ from: number; to: number }>,
): PendingDecoration[] {
  let pieces: Array<{ from: number; to: number }> = [{ from: decoration.from, to: decoration.to }];
  for (const range of replaceRanges) {
    if (range.to <= decoration.from || range.from >= decoration.to) continue;
    const next: Array<{ from: number; to: number }> = [];
    for (const piece of pieces) {
      if (range.to <= piece.from || range.from >= piece.to) {
        next.push(piece);
        continue;
      }
      if (range.from > piece.from) next.push({ from: piece.from, to: range.from });
      if (range.to < piece.to) next.push({ from: range.to, to: piece.to });
    }
    pieces = next;
  }
  return pieces.map((piece) => ({ ...piece, value: decoration.value }));
}

function appendDecorationRanges(
  target: Range<Decoration>[],
  decoration: PendingDecoration,
  replaceRanges: Array<{ from: number; to: number }>,
): void {
  const { from, to, value } = decoration;
  if (value.startSide !== undefined || value.endSide !== undefined) {
    target.push(Decoration.line(value).range(from));
  } else if (value.replace === true && value.widget === undefined) {
    if (from !== to) target.push(Decoration.replace({}).range(from, to));
  } else if (value.class !== undefined && value.widget === undefined) {
    if (from === to) return;
    for (const piece of clipMark(decoration, replaceRanges)) {
      if (piece.from < piece.to) {
        target.push(Decoration.mark(piece.value).range(piece.from, piece.to));
      }
    }
  } else if (value.widget !== undefined && from === to) {
    target.push(Decoration.widget({ widget: value.widget, side: value.side }).range(from));
  } else if (value.widget !== undefined) {
    target.push(Decoration.replace({ widget: value.widget }).range(from, to));
  }
}

function appendHiddenHeaderLines(
  ranges: Range<Decoration>[],
  view: EditorView,
  headerEndOffset: number,
): void {
  if (headerEndOffset <= 0) return;
  const selectionRanges = view.state.selection.ranges;
  if (shouldRevealMarkdownSyntax(view.hasFocus, selectionRanges, 0, headerEndOffset)) return;

  const doc = view.state.doc;
  const blockLastLine = doc.lineAt(Math.max(0, Math.min(headerEndOffset - 1, doc.length))).number;
  for (let lineNumber = 1; lineNumber <= blockLastLine; lineNumber++) {
    ranges.push(
      Decoration.line({ class: 'cm-header-tag-hidden' }).range(doc.line(lineNumber).from),
    );
  }
}

export function createDecorationSet(
  view: EditorView,
  decorations: PendingDecoration[],
  headerEndOffset: number,
): DecorationSet {
  const replaceRanges = collectReplaceRanges(decorations);
  const ranges: Range<Decoration>[] = [];

  for (const decoration of decorations) {
    try {
      appendDecorationRanges(ranges, decoration, replaceRanges);
    } catch (error) {
      console.warn('Invalid decoration:', decoration, error);
    }
  }
  appendHiddenHeaderLines(ranges, view, headerEndOffset);
  return Decoration.set(ranges, true);
}
