import { cursorLineDown, cursorLineUp } from '@codemirror/commands';
import { EditorSelection, Prec } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';

interface CursorCoords {
  lineNumber: number;
  top: number;
  left: number;
}

function cursorCoords(view: EditorView): CursorCoords | null {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const coords = view.coordsAtPos(head);
  if (!coords) return null;
  return { lineNumber: line.number, top: coords.top, left: coords.left };
}

function closestPositionOnAdjacentVisualRow(
  view: EditorView,
  lineNumber: number,
  fromTop: number,
  fromLeft: number,
  direction: 'up' | 'down',
): number | null {
  const line = view.state.doc.line(lineNumber);
  const rows = new Map<number, Array<{ pos: number; left: number }>>();
  const rowTops = new Map<number, number>();

  for (let pos = line.from; pos <= line.to; pos += 1) {
    const coords = view.coordsAtPos(pos);
    if (!coords) continue;
    const key = Math.round(coords.top);
    rowTops.set(key, coords.top);
    const row = rows.get(key);
    if (row) row.push({ pos, left: coords.left });
    else rows.set(key, [{ pos, left: coords.left }]);
  }

  let targetKey: number | null = null;
  let targetTop: number | null = null;
  for (const [key, top] of rowTops) {
    const isCandidate = direction === 'up' ? top < fromTop - 0.5 : top > fromTop + 0.5;
    if (!isCandidate) continue;
    if (
      targetTop === null ||
      (direction === 'up' ? top > targetTop : top < targetTop)
    ) {
      targetTop = top;
      targetKey = key;
    }
  }

  if (targetKey === null) return null;
  const candidates = rows.get(targetKey);
  if (!candidates?.length) return null;
  let best = candidates[0];
  let bestDistance = Math.abs(best.left - fromLeft);
  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(candidate.left - fromLeft);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best.pos;
}

function moveAcrossEmptyLine(view: EditorView, direction: 'up' | 'down'): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.head);
  if (line.text.length !== 0 || range.head !== line.from) return false;

  if (direction === 'up') {
    if (line.number <= 1) return false;
    const prevLine = state.doc.line(line.number - 1);
    view.dispatch({ selection: EditorSelection.cursor(prevLine.from) });
    return true;
  }

  if (line.number >= state.doc.lines) return false;
  const nextLine = state.doc.line(line.number + 1);
  view.dispatch({ selection: EditorSelection.cursor(nextLine.from) });
  return true;
}

function moveByVisualLine(view: EditorView, direction: 'up' | 'down'): boolean {
  const before = cursorCoords(view);
  const moved = direction === 'up' ? cursorLineUp(view) : cursorLineDown(view);
  if (!moved || !before) return moved;

  const after = cursorCoords(view);
  if (!after || after.lineNumber !== before.lineNumber) return true;
  const madeVerticalProgress =
    direction === 'up' ? after.top < before.top - 0.5 : after.top > before.top + 0.5;
  if (madeVerticalProgress) return true;

  const target = closestPositionOnAdjacentVisualRow(
    view,
    before.lineNumber,
    before.top,
    before.left,
    direction,
  );
  if (target !== null && target !== view.state.selection.main.head) {
    view.dispatch({ selection: EditorSelection.cursor(target) });
  }
  return true;
}

export const cursorMotionKeymap = Prec.highest(keymap.of([
  { key: 'ArrowUp', run: (view) => moveAcrossEmptyLine(view, 'up') || moveByVisualLine(view, 'up') },
  { key: 'ArrowDown', run: (view) => moveAcrossEmptyLine(view, 'down') || moveByVisualLine(view, 'down') },
]));
