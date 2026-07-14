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

type ListMarker =
  | { kind: 'unordered-task'; sourceLength: number; checked: boolean }
  | { kind: 'ordered-task'; sourceLength: number; checked: boolean; number: number }
  | { kind: 'bullet'; sourceLength: number }
  | { kind: 'ordered'; sourceLength: number; number: number };

function parseListMarker(text: string): ListMarker | null {
  const unorderedTask = text.match(/^([-*+])\s+\[([ xX])\]\s*/);
  if (unorderedTask) {
    return {
      kind: 'unordered-task',
      sourceLength: unorderedTask[0].length,
      checked: unorderedTask[2].toLowerCase() === 'x',
    };
  }

  const orderedTask = text.match(/^(\d+)\.\s+\[([ xX])\]\s*/);
  if (orderedTask) {
    return {
      kind: 'ordered-task',
      sourceLength: orderedTask[0].length,
      checked: orderedTask[2].toLowerCase() === 'x',
      number: Number.parseInt(orderedTask[1], 10),
    };
  }

  const bullet = text.match(/^([-*+])\s+/);
  if (bullet) return { kind: 'bullet', sourceLength: bullet[0].length };

  const ordered = text.match(/^(\d+)\.\s+/);
  if (ordered) {
    return {
      kind: 'ordered',
      sourceLength: ordered[0].length,
      number: Number.parseInt(ordered[1], 10),
    };
  }

  return null;
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
  const indentLevel = Math.floor((from - line.from) / 2);
  const marker = parseListMarker(text);

  addListLineDecoration(line.from, indentLevel, decorations);
  if (marker) {
    decorations.push({
      from,
      to: from + marker.sourceLength,
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
  const indentLevel = Math.floor((from - line.from) / 2);
  const marker = parseListMarker(text);
  if (!marker) return;

  const common = {
    from,
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
