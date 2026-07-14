import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

interface MarkdownSyntax {
  prefix: string;
  suffix: string;
  nodeName: string;
}

interface WrappedSyntaxRange {
  outerFrom: number;
  outerTo: number;
  innerFrom: number;
  innerTo: number;
}

const BOLD: MarkdownSyntax = { prefix: '**', suffix: '**', nodeName: 'StrongEmphasis' };
const ITALIC: MarkdownSyntax = { prefix: '*', suffix: '*', nodeName: 'Emphasis' };
const STRIKETHROUGH: MarkdownSyntax = { prefix: '~~', suffix: '~~', nodeName: 'Strikethrough' };

function splitSelectionWhitespace(text: string): { leading: number; trailing: number } {
  const leading = text.match(/^\s*/)?.[0].length ?? 0;
  const trailing = text.match(/\s*$/)?.[0].length ?? 0;
  return { leading, trailing };
}

function findOpeningMarkerOnLine(
  view: EditorView,
  cursorPosition: number,
  prefix: string,
): number | null {
  const line = view.state.doc.lineAt(cursorPosition);
  const lineTextBeforeCursor = view.state.sliceDoc(line.from, cursorPosition);
  const index = lineTextBeforeCursor.lastIndexOf(prefix);
  return index === -1 ? null : line.from + index;
}

function findWrappedSyntaxRange(
  view: EditorView,
  from: number,
  to: number,
  { prefix, suffix, nodeName }: MarkdownSyntax,
): WrappedSyntaxRange | null {
  let found: WrappedSyntaxRange | null = null;

  syntaxTree(view.state).iterate({
    from: Math.max(0, from - prefix.length),
    to: Math.min(view.state.doc.length, to + suffix.length),
    enter: (node) => {
      if (found || node.name !== nodeName) return;

      const outerFrom = node.from;
      const outerTo = node.to;
      const innerFrom = outerFrom + prefix.length;
      const innerTo = outerTo - suffix.length;
      if (innerFrom >= innerTo) return;

      const selectionMatches =
        (from === innerFrom && to === innerTo) ||
        (from === outerFrom && to === outerTo) ||
        (from === outerFrom && to === innerTo) ||
        (from === innerFrom && to === outerTo);

      if (selectionMatches) found = { outerFrom, outerTo, innerFrom, innerTo };
    },
  });

  return found;
}

function isStandaloneMarker(state: EditorState, from: number, to: number, marker: string): boolean {
  if (state.sliceDoc(from, to) !== marker) return false;
  if (marker.length !== 1) return true;

  const before = from > 0 ? state.sliceDoc(from - 1, from) : '';
  const after = to < state.doc.length ? state.sliceDoc(to, to + 1) : '';
  return before !== marker && after !== marker;
}

function findMarkerWrappedSelectionFallback(
  view: EditorView,
  from: number,
  to: number,
  { prefix, suffix }: MarkdownSyntax,
): WrappedSyntaxRange | null {
  const { state } = view;

  if (
    isStandaloneMarker(state, from, from + prefix.length, prefix) &&
    isStandaloneMarker(state, to - suffix.length, to, suffix) &&
    from + prefix.length < to - suffix.length
  ) {
    return {
      outerFrom: from,
      outerTo: to,
      innerFrom: from + prefix.length,
      innerTo: to - suffix.length,
    };
  }

  const prefixStart = from - prefix.length;
  const suffixEnd = to + suffix.length;
  if (
    prefixStart >= 0 &&
    suffixEnd <= state.doc.length &&
    isStandaloneMarker(state, prefixStart, from, prefix) &&
    isStandaloneMarker(state, to, suffixEnd, suffix)
  ) {
    return {
      outerFrom: prefixStart,
      outerTo: suffixEnd,
      innerFrom: from,
      innerTo: to,
    };
  }

  return null;
}

function unwrapSyntaxRange(view: EditorView, range: WrappedSyntaxRange): void {
  const { anchor, head } = view.state.selection.main;
  const openLength = range.innerFrom - range.outerFrom;
  const closeLength = range.outerTo - range.innerTo;
  const mapPosition = (position: number): number => {
    if (position <= range.outerFrom) return position;
    if (position <= range.innerFrom) return range.outerFrom;
    if (position <= range.innerTo) return position - openLength;
    if (position <= range.outerTo) return range.innerTo - openLength;
    return position - openLength - closeLength;
  };

  view.dispatch({
    changes: [
      { from: range.outerFrom, to: range.innerFrom, insert: '' },
      { from: range.innerTo, to: range.outerTo, insert: '' },
    ],
    selection: { anchor: mapPosition(anchor), head: mapPosition(head) },
  });
}

function toggleSyntax(view: EditorView, syntax: MarkdownSyntax): void {
  const { prefix, suffix } = syntax;
  const { state } = view;
  const { from, to } = state.selection.main;

  if (from === to) {
    const afterText = state.sliceDoc(from, from + suffix.length);
    if (afterText === suffix) {
      const beforeText = state.sliceDoc(Math.max(0, from - prefix.length), from);
      if (beforeText === prefix) {
        view.dispatch({
          changes: { from: from - prefix.length, to: from + suffix.length, insert: '' },
          selection: { anchor: from - prefix.length },
        });
      } else {
        const openPosition = findOpeningMarkerOnLine(view, from, prefix);
        if (openPosition !== null) {
          const contentStart = openPosition + prefix.length;
          const innerText = state.sliceDoc(contentStart, from);
          const trailingWhitespace = innerText.match(/\s+$/)?.[0] ?? '';
          if (trailingWhitespace.length > 0) {
            const trimmedInner = innerText.slice(0, -trailingWhitespace.length);
            const replacement = `${prefix}${trimmedInner}${suffix}${trailingWhitespace}`;
            view.dispatch({
              changes: { from: openPosition, to: from + suffix.length, insert: replacement },
              selection: {
                anchor:
                  openPosition +
                  prefix.length +
                  trimmedInner.length +
                  suffix.length +
                  trailingWhitespace.length,
              },
            });
            view.focus();
            return;
          }
        }
        view.dispatch({ selection: { anchor: from + suffix.length } });
      }
      view.focus();
      return;
    }

    view.dispatch({
      changes: { from, insert: prefix + suffix },
      selection: { anchor: from + prefix.length },
    });
    view.focus();
    return;
  }

  const selectedText = state.sliceDoc(from, to);
  const { leading, trailing } = splitSelectionWhitespace(selectedText);
  const coreFrom = from + leading;
  const coreTo = to - trailing;

  if (coreFrom >= coreTo) {
    view.dispatch({
      changes: [
        { from, insert: prefix },
        { from: to, insert: suffix },
      ],
      selection: { anchor: from + prefix.length, head: to + prefix.length },
    });
    view.focus();
    return;
  }

  const wrappedRange =
    findWrappedSyntaxRange(view, coreFrom, coreTo, syntax) ??
    findMarkerWrappedSelectionFallback(view, coreFrom, coreTo, syntax);

  if (wrappedRange) {
    unwrapSyntaxRange(view, wrappedRange);
  } else {
    view.dispatch({
      changes: [
        { from: coreFrom, insert: prefix },
        { from: coreTo, insert: suffix },
      ],
      selection: { anchor: coreFrom + prefix.length, head: coreTo + prefix.length },
    });
  }
  view.focus();
}

export function toggleBold(view: EditorView): void {
  toggleSyntax(view, BOLD);
}

export function toggleItalic(view: EditorView): void {
  toggleSyntax(view, ITALIC);
}

export function toggleStrikethrough(view: EditorView): void {
  toggleSyntax(view, STRIKETHROUGH);
}
