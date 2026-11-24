/* Every mouse gesture in the note pane, through one hit-test: the browser places and drags
 * no selection itself. A press selects by its click count (a caret, the engine's word, the
 * whole line without its break); Shift extends from the selection's anchor; a drag extends
 * by the same unit, deselecting at once when it comes back past the press, and scrolls the
 * pane while the pointer is beyond it. A press on selected text that then moves drags the
 * text instead: a drop caret follows the pointer, and the release moves the text there
 * through the engine, one Undo step; a press there that does not move places the caret. A
 * press on a divider or an image selects it whole, one on a list item's marker places the
 * caret beside it as on a character, one on a task's checkbox toggles it, one on a code
 * block's header or below its end is the block's (codeBlockPress.ts), and one on the box a
 * short table row lacks a cell in enters that cell (tableFillerPress.ts). Where a press
 * lands is the hit-test's (hitTest.ts). */
import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import { TASK_BOX_CLASS } from './atomElements';
import { pressCodeBlock } from './codeBlockPress';
import type { Hit } from './hitTest';
import { scrollerOf } from './paneScroll';
import { pressTableFiller } from './tableFillerPress';
import type { EditorView } from './view';

/** How far past the pane's edge a drag scrolls at its fastest, and that speed per frame. */
const SCROLL_REACH = 80;
const SCROLL_STEP = 40;
/** How far a press on selected text (or a link: linkPress.ts) moves before it drags, CSS px. */
export const MOVE_SLOP = 4;

interface Gesture {
  /** What the press selected, which the selection always holds. */
  pressed: DisplayRange;
  unit: number;
  x: number;
  y: number;
  scroller: HTMLElement;
  /** A press on selected text: the text, and where it would drop (null until it moves). */
  moving?: { range: DisplayRange; at: Hit; drop: number | null };
}

export class EditorPointer {
  private gesture: Gesture | null = null;
  private scrollFrame = 0;
  private readonly move = (event: MouseEvent) => this.drag(event);
  private readonly up = () => this.finish();
  private dropCaret: HTMLElement | null = null;

  constructor(private readonly view: EditorView) {}

  /** A press; one on a link opens it on release instead (linkPress.ts), unless `onLinks` is
   *  false: that press moved, and selects from where it began. */
  down(event: MouseEvent, onLinks = true): void {
    const view = this.view;
    if (onLinks && view.linkPress.press(event)) return;
    // A secondary press, and Ctrl+click on Apple, open the context menu.
    if (event.button !== 0 || (event.ctrlKey && navigator.platform.startsWith('Mac'))) return;
    if (!view.displayLines().length) return;
    event.preventDefault();
    // A task's checkbox toggles, unless the note is read-only, and the caret, the selection,
    // the focus and the scroll stay.
    const box = (event.target as Element).closest?.(`.${TASK_BOX_CLASS}`);
    if (box?.parentNode) {
      // Only a click's first press toggles: a double click toggles once, not back.
      if (!view.dom.isContentEditable || event.detail > 1) return;
      const at = view.offsetOf(box.parentNode, 0);
      view.run((engine) => engine.blockCommand({ start: at, end: at }, 'ToggleTask'), false);
      return;
    }
    if (pressCodeBlock(view, event)) return;
    if (pressTableFiller(view, event)) return;
    // Shift extends from the anchor: the page's, or the engine's start when the editor has
    // no focus (and so no selection on the page). Read before focusing, which leaves the
    // page's selection to this press.
    const shown = view.selection.ends();
    const anchor = event.shiftKey ? (shown?.anchor ?? view.selection.range()?.start) : undefined;
    if (!view.hasFocus()) view.focus(false);
    const scroller = scrollerOf(view.dom);
    const hit = this.view.hitTest.offsetAt(event.clientX, event.clientY, scroller, true);
    const at = hit.offset;
    const unit = anchor === undefined ? Math.min(Math.max(event.detail, 1), 3) : 1;
    const pressed = anchor === undefined ? this.unitAt(hit, unit) : { start: anchor, end: anchor };
    this.gesture = { pressed, unit, x: event.clientX, y: event.clientY, scroller };
    const selected = view.selection.range();
    // Only a selection on the page is dragged: an editor without focus shows none.
    if (shown && unit === 1 && anchor === undefined && selected && selected.start < selected.end) {
      if (selected.start <= at && at <= selected.end) {
        this.gesture.moving = { range: selected, at: hit, drop: null };
      }
    }
    if (!this.gesture.moving) this.selectTo(hit);
    document.addEventListener('mousemove', this.move);
    document.addEventListener('mouseup', this.up);
  }

  destroy(): void {
    this.release();
  }

  /** A press is held: the selection toolbar waits for its release. */
  dragging(): boolean {
    return this.gesture !== null;
  }

  /** The held press moved (linkPress.ts hands on the move that made a press on a link one). */
  drag(event: MouseEvent): void {
    const gesture = this.gesture;
    if (!gesture) return;
    if (!(event.buttons & 1)) return this.release();
    const moving = gesture.moving;
    if (
      moving?.drop === null &&
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < MOVE_SLOP
    )
      return;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    this.track();
    this.autoScroll();
  }

  /** The pointer moved (or the pane scrolled under it): select to it, or move the drop. */
  private track(): void {
    const gesture = this.gesture!;
    const hit = this.view.hitTest.offsetAt(gesture.x, gesture.y, gesture.scroller, true);
    if (!gesture.moving) return this.selectTo(hit);
    gesture.moving.drop = hit.offset;
    this.showDrop(hit);
  }

  /** The button came up: a text drag moves the text to its drop; a press on selected text
   *  that never moved places the caret there, as a click does. */
  private finish(): void {
    const moving = this.gesture?.moving;
    this.release();
    if (!moving) return;
    if (moving.drop === null)
      this.view.selection.select(moving.at.offset, moving.at.offset, moving.at);
    else this.view.moveText(moving.range, moving.drop);
  }

  /** The drop caret: a caret at the drop, drawn over the text while it is dragged. */
  private showDrop({ offset, rowEnd }: Hit): void {
    const view = this.view;
    const origin = view.dom.parentElement!;
    if (!this.dropCaret) {
      this.dropCaret = document.createElement('div');
      this.dropCaret.className = 'desktop-drop';
      this.dropCaret.setAttribute('aria-hidden', 'true');
      origin.append(this.dropCaret);
    }
    const base = origin.getBoundingClientRect();
    const line = view.lineElements()[view.lineAt(offset)].getBoundingClientRect();
    const rect =
      view.caretSide.clientRect(offset, rowEnd) ?? new DOMRect(line.left, line.top, 0, line.height);
    const style = this.dropCaret.style;
    style.transform = `translate(${rect.left - base.left}px, ${rect.top - base.top}px)`;
    style.height = `${rect.height}px`;
  }

  private release(): void {
    this.dropCaret?.remove();
    this.dropCaret = null;
    // The selection the press made gets its toolbar on the next frame.
    if (this.gesture) this.view.redraw();
    this.gesture = null;
    cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    document.removeEventListener('mousemove', this.move);
    document.removeEventListener('mouseup', this.up);
  }

  /** While the pointer is above or below the pane, scroll toward it each frame, faster the
   *  further out it is, and select to the text at the pane's edge. Runs only then. */
  private autoScroll(): void {
    const gesture = this.gesture;
    if (!gesture || this.scrollFrame) return;
    const pane = gesture.scroller.getBoundingClientRect();
    const beyond =
      gesture.y < pane.top ? gesture.y - pane.top : Math.max(0, gesture.y - pane.bottom);
    if (beyond === 0) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      if (this.gesture !== gesture) return;
      const step =
        Math.sign(beyond) *
        Math.ceil((Math.min(Math.abs(beyond), SCROLL_REACH) / SCROLL_REACH) * SCROLL_STEP);
      gesture.scroller.scrollTop += step;
      this.track();
      this.autoScroll();
    });
  }

  /** Select from the press to `hit`, by the press's unit: the selection always holds what
   *  the press selected, and grows from its far side. */
  private selectTo(hit: Hit): void {
    const { pressed, unit } = this.gesture!;
    const head = this.unitAt(hit, unit);
    const backward = head.start < pressed.start;
    const anchor = backward ? pressed.end : pressed.start;
    const focus = backward ? head.start : Math.max(head.end, pressed.end);
    this.view.selection.select(anchor, focus, {
      rowEnd: hit.rowEnd && focus === hit.offset,
      arrival: hit.arrival,
    });
  }

  /** A click count's unit at `hit`: the caret, the engine's word (a list marker pressed on is
   *  its own word), the line, a list item's marker included. An atom is taken whole by any
   *  count. */
  private unitAt({ offset, atom, marker }: Hit, unit: number): DisplayRange {
    if (atom) return atom;
    if (unit === 1) return { start: offset, end: offset };
    if (unit === 2) return marker ?? this.view.wordAt(offset);
    const line = this.view.displayLines()[this.view.lineAt(offset)];
    return { start: line.start, end: line.start + line.text.length };
  }
}
