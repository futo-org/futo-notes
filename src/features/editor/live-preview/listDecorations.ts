import { EditorView, WidgetType } from '@codemirror/view';

import type { PendingDecoration } from './decorationTypes';
import { selectionWithinMarkerRange } from './selectionReveal';
import { TaskCheckboxWidget } from './widgets';

const INDENT_STEP = 24;

class BulletWidget extends WidgetType {
  constructor(private indent = 0) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    const glyphs = ['•', '◦', '▪'];
    span.textContent = glyphs[this.indent % glyphs.length];
    span.style.cssText = 'padding-right: 4px; color: #666;';
    return span;
  }

  get estimatedHeight(): number {
    return 0;
  }

  eq(other: BulletWidget): boolean {
    return other instanceof BulletWidget && other.indent === this.indent;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class NumberWidget extends WidgetType {
  constructor(
    private num: number,
    private indent = 0,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-number';
    span.textContent = `${this.num}.`;
    span.style.cssText = 'padding-right: 8px; color: #666; font-weight: 500;';
    return span;
  }

  get estimatedHeight(): number {
    return 0;
  }

  eq(other: NumberWidget): boolean {
    return other instanceof NumberWidget && other.num === this.num && other.indent === this.indent;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// `indent` is the leading whitespace before the marker; `sourceLength` is
// measured from the marker itself, so a caller places marker decorations at
// `nodeFrom + indent` and finds the item's content at `+ sourceLength` past it.
type ListMarker =
  | { kind: 'unordered-task'; indent: number; sourceLength: number; checked: boolean }
  | { kind: 'ordered-task'; indent: number; sourceLength: number; checked: boolean; number: number }
  | { kind: 'bullet'; indent: number; sourceLength: number }
  | { kind: 'ordered'; indent: number; sourceLength: number; number: number };

// lezer-markdown spans a ListItem from the MARKER when the item opens a nested
// list, but from the LINE START — leading indent included — when the item is a
// sibling that merely happens to be indented. `*  Parent.` puts its content at
// column 3, so a two-space child is not deep enough to nest and CommonMark
// demotes it to an outer-list sibling; a whole list indented by one space is
// the same shape. Matching the marker without allowing for that indent dropped
// every decoration for those items, leaving raw `*` on screen.
function parseListMarker(text: string): ListMarker | null {
  const indent = text.length - text.replace(/^[ \t]+/, '').length;
  const body = text.slice(indent);

  const unorderedTask = body.match(/^([-*+])\s+\[([ xX])\]\s*/);
  if (unorderedTask) {
    return {
      kind: 'unordered-task',
      indent,
      sourceLength: unorderedTask[0].length,
      checked: unorderedTask[2].toLowerCase() === 'x',
    };
  }

  const orderedTask = body.match(/^(\d+)\.\s+\[([ xX])\]\s*/);
  if (orderedTask) {
    return {
      kind: 'ordered-task',
      indent,
      sourceLength: orderedTask[0].length,
      checked: orderedTask[2].toLowerCase() === 'x',
      number: Number.parseInt(orderedTask[1], 10),
    };
  }

  const bullet = body.match(/^([-*+])\s+/);
  if (bullet) return { kind: 'bullet', indent, sourceLength: bullet[0].length };

  const ordered = body.match(/^(\d+)\.\s+/);
  if (ordered) {
    return {
      kind: 'ordered',
      indent,
      sourceLength: ordered[0].length,
      number: Number.parseInt(ordered[1], 10),
    };
  }

  return null;
}

// Visual depth comes from where lezer STARTS the ListItem node, not from
// counting the line's leading spaces. The tree already resolved the semantics:
// a genuine child opens a nested list at the marker (so nodeFrom - lineFrom is
// the item's own indent), while a sibling that is merely indented spans from
// the line start (giving 0 — which is right, since it renders level with its
// siblings even though spaces precede it).
function listIndentLevel(nodeFrom: number, lineFrom: number): number {
  return Math.floor((nodeFrom - lineFrom) / 2);
}

function listLineStyle(indentLevel: number): string {
  return `text-indent: ${indentLevel * INDENT_STEP}px;`;
}

function addListLineDecoration(
  lineFrom: number,
  indentLevel: number,
  decorations: PendingDecoration[],
): void {
  decorations.push({
    from: lineFrom,
    to: lineFrom,
    value: {
      class: 'cm-md-list-line',
      attributes: { style: listLineStyle(indentLevel) },
      startSide: 0,
      endSide: 0,
    },
  });
}

function addTaskDecorations(params: {
  from: number;
  lineEnd: number;
  lineFrom: number;
  indentLevel: number;
  marker: Extract<ListMarker, { kind: 'unordered-task' | 'ordered-task' }>;
  view: EditorView;
  decorations: PendingDecoration[];
}): void {
  const { from, lineEnd, lineFrom, indentLevel, marker, view, decorations } = params;
  const contentStart = from + marker.sourceLength;
  const revealed = selectionWithinMarkerRange(
    view.hasFocus,
    view.state.selection.ranges,
    from,
    contentStart,
  );

  if (revealed) {
    decorations.push({ from, to: contentStart, value: { class: 'cm-md-inline-marker' } });
  } else {
    decorations.push({
      from,
      to: contentStart,
      value: { replace: true, wrapInsideMark: true },
    });
    if (marker.kind === 'ordered-task') {
      decorations.push({
        from,
        to: from,
        value: { widget: new NumberWidget(marker.number, indentLevel), side: -1 },
      });
    }
    decorations.push({
      from,
      to: from,
      value: { widget: new TaskCheckboxWidget(marker.checked), side: -1 },
    });
  }

  if (contentStart < lineEnd) {
    decorations.push({ from: contentStart, to: lineEnd, value: { class: 'cm-md-task' } });
  }
  addListLineDecoration(lineFrom, indentLevel, decorations);
}

function addBulletDecorations(params: {
  from: number;
  lineEnd: number;
  lineFrom: number;
  indentLevel: number;
  marker: Extract<ListMarker, { kind: 'bullet' }>;
  view: EditorView;
  decorations: PendingDecoration[];
}): void {
  const { from, lineEnd, lineFrom, indentLevel, marker, view, decorations } = params;
  const contentStart = from + marker.sourceLength;
  const revealed = selectionWithinMarkerRange(
    view.hasFocus,
    view.state.selection.ranges,
    from,
    contentStart,
  );

  decorations.push(
    revealed
      ? { from, to: from + 1, value: { class: 'cm-md-inline-marker' } }
      : { from, to: from + 1, value: { widget: new BulletWidget(indentLevel) } },
  );
  if (contentStart < lineEnd) {
    decorations.push({ from: contentStart, to: lineEnd, value: { class: 'cm-md-ul-item' } });
  }
  addListLineDecoration(lineFrom, indentLevel, decorations);
}

function addOrderedDecorations(params: {
  from: number;
  lineEnd: number;
  lineFrom: number;
  indentLevel: number;
  marker: Extract<ListMarker, { kind: 'ordered' }>;
  view: EditorView;
  decorations: PendingDecoration[];
}): void {
  const { from, lineEnd, lineFrom, indentLevel, marker, view, decorations } = params;
  const contentStart = from + marker.sourceLength;
  const revealed = selectionWithinMarkerRange(
    view.hasFocus,
    view.state.selection.ranges,
    from,
    contentStart,
  );

  decorations.push(
    revealed
      ? { from, to: contentStart, value: { class: 'cm-md-inline-marker' } }
      : {
          from,
          to: contentStart,
          value: { widget: new NumberWidget(marker.number, indentLevel) },
        },
  );
  if (contentStart < lineEnd) {
    decorations.push({ from: contentStart, to: lineEnd, value: { class: 'cm-md-ol-item' } });
  }
  addListLineDecoration(lineFrom, indentLevel, decorations);
}

export function decorateListItemIndentOnly(
  from: number,
  view: EditorView,
  decorations: PendingDecoration[],
): void {
  const line = view.state.doc.lineAt(from);
  const text = view.state.doc.sliceString(from, line.to);
  const indentLevel = listIndentLevel(from, line.from);
  const marker = parseListMarker(text);

  addListLineDecoration(line.from, indentLevel, decorations);
  if (marker) {
    const markerFrom = from + marker.indent;
    decorations.push({
      from: markerFrom,
      to: markerFrom + marker.sourceLength,
      value: { class: 'cm-md-bullet cm-md-list-marker' },
    });
  }
}

export function decorateListItem(
  from: number,
  text: string,
  view: EditorView,
  decorations: PendingDecoration[],
): void {
  const line = view.state.doc.lineAt(from);
  const indentLevel = listIndentLevel(from, line.from);
  const marker = parseListMarker(text);
  if (!marker) return;

  const common = {
    from: from + marker.indent,
    lineEnd: line.to,
    lineFrom: line.from,
    indentLevel,
    view,
    decorations,
  };

  if (marker.kind === 'unordered-task' || marker.kind === 'ordered-task') {
    addTaskDecorations({ ...common, marker });
  } else if (marker.kind === 'bullet') {
    addBulletDecorations({ ...common, marker });
  } else {
    addOrderedDecorations({ ...common, marker });
  }
}
