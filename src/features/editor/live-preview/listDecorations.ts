import { EditorView, WidgetType } from '@codemirror/view';

import type { PendingDecoration } from './decorationTypes';
import { selectionWithinMarkerRange } from './selectionReveal';
import { TaskCheckboxWidget } from './widgets';

const INDENT_STEP = 24;

/**
 * The marker slot: the column an item's text starts at, and the column its
 * wrapped rows hang to. One CSS length drives all three users — the marker
 * widget's width, the revealed raw marker's width, and the line's hanging
 * indent — so they line up by construction instead of by matching glyph
 * metrics. The line consumes it as `--list-marker-slot` (markdown-blocks.css).
 *
 * `1ch` is the advance width of `0`, so an N-digit number really is N ch wide.
 * The checkbox is a font-independent 28px: TaskCheckboxWidget's wrapper carries
 * that as a border-box `min-width`, with its 4px padding inside.
 */
const BULLET_SLOT = '1em';
const CHECKBOX_SLOT = '28px';

function orderedSlot(num: number): string {
  return `calc(${Math.max(1, String(num).length)}ch + 0.5em)`;
}

function markerSlot(marker: ListMarker): string {
  switch (marker.kind) {
    case 'bullet':
      return BULLET_SLOT;
    case 'ordered':
      return orderedSlot(marker.number);
    case 'unordered-task':
      return CHECKBOX_SLOT;
    case 'ordered-task':
      return `calc(${orderedSlot(marker.number)} + ${CHECKBOX_SLOT})`;
  }
}

class BulletWidget extends WidgetType {
  constructor(private indent = 0) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    const glyphs = ['•', '◦', '▪'];
    span.textContent = glyphs[this.indent % glyphs.length];
    // Pinned to the slot the line hangs to, so wrapped text lands on the same
    // x as the first line's text.
    span.style.cssText = `display: inline-block; width: ${BULLET_SLOT}; color: #666;`;
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
    // Same contract as BulletWidget: the widget occupies exactly the column
    // the line's continuation rows hang to.
    span.style.cssText = `display: inline-block; width: ${orderedSlot(this.num)}; color: #666; font-weight: 500;`;
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

// The two inputs to the hanging indent; markdown-blocks.css turns them into
// margin + a negative first-line text-indent.
function addListLineDecoration(
  lineFrom: number,
  indentLevel: number,
  slot: string,
  decorations: PendingDecoration[],
): void {
  decorations.push({
    from: lineFrom,
    to: lineFrom,
    value: {
      class: 'cm-md-list-line',
      attributes: {
        style: `--list-depth: ${indentLevel * INDENT_STEP}px; --list-marker-slot: ${slot};`,
      },
      startSide: 0,
      endSide: 0,
    },
  });
}

// The caret is on the marker, so the raw source shows instead of the widget.
// It claims the same slot the widget would, so entering and leaving the marker
// doesn't shift the item's text — `min-width` rather than `width` because a
// deeply indented item's source is wider than the slot, and a pinned width
// would make it overlap the text that follows.
function revealedMarkerDecoration(
  hiddenFrom: number,
  contentStart: number,
  slot: string,
): PendingDecoration {
  return {
    from: hiddenFrom,
    to: contentStart,
    value: {
      class: 'cm-md-inline-marker cm-md-list-marker-slot',
      attributes: { style: `min-width: ${slot};` },
    },
  };
}

function addTaskDecorations(params: {
  from: number;
  hiddenFrom: number;
  lineEnd: number;
  lineFrom: number;
  indentLevel: number;
  marker: Extract<ListMarker, { kind: 'unordered-task' | 'ordered-task' }>;
  view: EditorView;
  decorations: PendingDecoration[];
}): void {
  const { from, hiddenFrom, lineEnd, lineFrom, indentLevel, marker, view, decorations } = params;
  const contentStart = from + marker.sourceLength;
  const revealed = selectionWithinMarkerRange(
    view.hasFocus,
    view.state.selection.ranges,
    hiddenFrom,
    contentStart,
  );

  if (revealed) {
    decorations.push(revealedMarkerDecoration(hiddenFrom, contentStart, markerSlot(marker)));
  } else {
    decorations.push({
      from: hiddenFrom,
      to: contentStart,
      value: { replace: true, wrapInsideMark: true },
    });
    if (marker.kind === 'ordered-task') {
      decorations.push({
        from: hiddenFrom,
        to: hiddenFrom,
        value: { widget: new NumberWidget(marker.number, indentLevel), side: -1 },
      });
    }
    decorations.push({
      from: hiddenFrom,
      to: hiddenFrom,
      value: { widget: new TaskCheckboxWidget(marker.checked), side: -1 },
    });
  }

  if (contentStart < lineEnd) {
    decorations.push({ from: contentStart, to: lineEnd, value: { class: 'cm-md-task' } });
  }
  addListLineDecoration(lineFrom, indentLevel, markerSlot(marker), decorations);
}

function addBulletDecorations(params: {
  from: number;
  hiddenFrom: number;
  lineEnd: number;
  lineFrom: number;
  indentLevel: number;
  marker: Extract<ListMarker, { kind: 'bullet' }>;
  view: EditorView;
  decorations: PendingDecoration[];
}): void {
  const { from, hiddenFrom, lineEnd, lineFrom, indentLevel, marker, view, decorations } = params;
  const contentStart = from + marker.sourceLength;
  const revealed = selectionWithinMarkerRange(
    view.hasFocus,
    view.state.selection.ranges,
    hiddenFrom,
    contentStart,
  );

  decorations.push(
    revealed
      ? revealedMarkerDecoration(hiddenFrom, contentStart, BULLET_SLOT)
      : // Replaces the marker AND its trailing space, the way the ordered and
        // task markers already do. Leaving the space behind put the item's
        // text one space right of the slot its wrapped rows hang to.
        { from: hiddenFrom, to: contentStart, value: { widget: new BulletWidget(indentLevel) } },
  );
  if (contentStart < lineEnd) {
    decorations.push({ from: contentStart, to: lineEnd, value: { class: 'cm-md-ul-item' } });
  }
  addListLineDecoration(lineFrom, indentLevel, markerSlot(marker), decorations);
}

function addOrderedDecorations(params: {
  from: number;
  hiddenFrom: number;
  lineEnd: number;
  lineFrom: number;
  indentLevel: number;
  marker: Extract<ListMarker, { kind: 'ordered' }>;
  view: EditorView;
  decorations: PendingDecoration[];
}): void {
  const { from, hiddenFrom, lineEnd, lineFrom, indentLevel, marker, view, decorations } = params;
  const contentStart = from + marker.sourceLength;
  const revealed = selectionWithinMarkerRange(
    view.hasFocus,
    view.state.selection.ranges,
    hiddenFrom,
    contentStart,
  );

  decorations.push(
    revealed
      ? revealedMarkerDecoration(hiddenFrom, contentStart, orderedSlot(marker.number))
      : {
          from: hiddenFrom,
          to: contentStart,
          value: { widget: new NumberWidget(marker.number, indentLevel) },
        },
  );
  if (contentStart < lineEnd) {
    decorations.push({ from: contentStart, to: lineEnd, value: { class: 'cm-md-ol-item' } });
  }
  addListLineDecoration(lineFrom, indentLevel, markerSlot(marker), decorations);
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

  // The raw marker is on screen here, so its width is the source text's, not
  // the widget's — but the line keeps the same content column either way, so
  // wrapped rows don't jump as the caret enters and leaves the item.
  addListLineDecoration(line.from, indentLevel, marker ? markerSlot(marker) : '0px', decorations);
  if (marker) {
    const markerFrom = from + marker.indent;
    decorations.push({
      from: markerFrom,
      to: markerFrom + marker.sourceLength,
      value: { class: 'cm-md-bullet cm-md-list-marker' },
    });
  }
}

// Where the hidden run starts: the marker, extended back over the line's
// leading indentation when that indentation reaches the line start. Those
// spaces are markdown source exactly like the marker — visual depth comes from
// the line's margin — and leaving them on screen pushed the item's text one
// space per indent level right of the column its wrapped rows hang to.
// Requiring them to reach the line start is what keeps a list inside a
// blockquote intact: there the run stops at the `>`, which the quote decorator
// owns, so nothing is hidden.
function hiddenMarkerStart(view: EditorView, lineFrom: number, markerFrom: number): number {
  if (markerFrom <= lineFrom) return markerFrom;
  const lead = view.state.doc.sliceString(lineFrom, markerFrom);
  return /^[ \t]+$/.test(lead) ? lineFrom : markerFrom;
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

  const markerFrom = from + marker.indent;
  const common = {
    from: markerFrom,
    hiddenFrom: hiddenMarkerStart(view, line.from, markerFrom),
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
