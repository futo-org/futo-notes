import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { findMatches, type FindMatch } from './findMatches';
import { findState } from './findState';

const matchDecoration = Decoration.mark({ class: 'cm-find-match' });
const currentMatchDecoration = Decoration.mark({ class: 'cm-find-match cm-find-match-current' });

function intersects(match: FindMatch, range: { from: number; to: number }): boolean {
  return match.from < range.to && match.to > range.from;
}

export function buildFindDecorations(view: EditorView): DecorationSet {
  const value = view.state.field(findState);
  if (!value.open || !value.query) return Decoration.none;

  const current = value.matches[value.currentIndex];
  const seen = new Set<string>();
  const ranges: Array<{ from: number; to: number; value: Decoration }> = [];
  for (const visible of view.visibleRanges) {
    const padding = value.query.length;
    const from = Math.max(0, visible.from - padding);
    const to = Math.min(view.state.doc.length, visible.to + padding);
    for (const match of findMatches(view.state.doc, value.query, from, to)) {
      if (!intersects(match, visible)) continue;
      const key = `${match.from}:${match.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranges.push({
        from: match.from,
        to: match.to,
        value:
          current && current.from === match.from && current.to === match.to
            ? currentMatchDecoration
            : matchDecoration,
      });
    }
  }
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  return Decoration.set(ranges);
}

export const findDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildFindDecorations(view);
    }

    update(update: ViewUpdate): void {
      const previous = update.startState.field(findState);
      const current = update.state.field(findState);
      if (update.docChanged || update.viewportChanged || previous !== current) {
        this.decorations = buildFindDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
