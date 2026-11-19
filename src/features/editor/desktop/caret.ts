/* The editor's drawn caret (the native one is transparent): a line at a measured point,
 * drawn on the next frame after anything that can move it (with the selection's highlight),
 * only while the window has focus, and restarting its blink on every keystroke or move. Its
 * flag, a pennant at its top, shows the formats the next typed character takes; it is a child
 * of the caret beside its bar, so it moves and hides with it and costs no layout read, and
 * stays lit while the bar blinks. After
 * an edit the same measure brings the caret's row into the pane (`follow`). At a
 * soft wrap the end of the upper row and the start of the lower one are one offset: a caret
 * put at the row's end (selection.ts `select`) is measured there, the browser's on the lower row. */
import { snapCaretToDevicePixels } from './caretPixels';
import { withMeasuringRange } from './lineElements';
import { lineRowAt, lineRowSizesOf, lineRows } from './lineRowAt';
import { pictureStopRect } from './pictureStops';
import { emptyCellStopRect } from './tableRowElements';
import { wikilinkStopRect } from './wikilinkElements';
import { reveal, scrollerOf } from './paneScroll';
import type { KeystrokeTimings } from './timings';

export interface CaretBox {
  left: number;
  top: number;
  height: number;
}

/** How far back a row end's measure starts: far enough for any grapheme before the caret,
 *  near enough that a long line costs what a short one does. */
const ROW_END_REACH = 64;

/** The canvas `fontTextHeight` measures with, made on first use. */
let fontMeasure: CanvasRenderingContext2D | null = null;

/** Each font's ascent plus descent at 1000px, by its canvas font string: a caret is drawn on
 *  every move, and a face's metrics do not change. Cleared when a face finishes loading (the
 *  fallback's metrics were measured until then). */
const fontHeightsPerThousand = new Map<string, number>();
document.fonts?.addEventListener('loadingdone', () => fontHeightsPerThousand.clear());

/** The height of the box `style`'s font gives its own text, as a collapsed range in that
 *  text measures it: the font's ascent and descent, which differ from font to font. */
function fontTextHeight(style: CSSStyleDeclaration): number {
  // Canvas metrics are whole pixels: measured large, then scaled to the font's size.
  const font = `${style.fontStyle} ${style.fontWeight} 1000px ${style.fontFamily}`;
  let heightPerThousand = fontHeightsPerThousand.get(font);
  if (heightPerThousand === undefined) {
    fontMeasure ??= document.createElement('canvas').getContext('2d');
    if (!fontMeasure) return parseFloat(style.lineHeight);
    fontMeasure.font = font;
    const metrics = fontMeasure.measureText('');
    heightPerThousand = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    fontHeightsPerThousand.set(font, heightPerThousand);
  }
  return (heightPerThousand * parseFloat(style.fontSize)) / 1000;
}

/** Where a caret at `node`/`offset` draws (viewport px): a collapsed range's box, or with
 *  `rowEnd` the end of the text before it on that text's row, kept inside the line (a space
 *  at a wrap hangs past it). Null where no glyph box is drawn (an empty line). */
export function caretViewportRect(node: Node, offset: number, rowEnd = false): DOMRect | null {
  const stop =
    pictureStopRect(node, offset) ?? wikilinkStopRect(node, offset) ?? emptyCellStopRect(node);
  if (stop) return stop;
  return withMeasuringRange((range) => {
    if (!rowEnd || offset === 0 || !(node instanceof Text)) {
      range.setStart(node, offset);
      range.collapse(true);
      const rect = range.getClientRects()[0];
      return rect?.height ? rect : null;
    }
    // From a few characters back in the node (`node` holds the text before the caret, view.ts
    // `pointAt`), never the second half of a surrogate pair.
    let start = Math.max(0, offset - ROW_END_REACH);
    const code = node.data.charCodeAt(start);
    if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start--;
    range.setStart(node, start);
    range.setEnd(node, offset);
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1];
    if (!rect?.height) return null;
    const right = node.parentElement?.getBoundingClientRect().right ?? rect.right;
    return new DOMRect(Math.min(rect.right, right), rect.top, 0, rect.height);
  });
}

/** Where a caret at `node`/`offset` draws (see `caretViewportRect`), relative to `origin`.
 *  Its x is the point between glyphs, so it stands upright in italic text. An empty line has
 *  no glyph box, and text in a format's span (inline code) has its own font's: the caret
 *  takes the box the line's font would give its own text, centred on the row,
 *  as the native caret sits, so it is as tall in a run as beside it. A code line's caret
 *  takes the body text's box (its parent's font), as tall as a paragraph's. */
export function measureCaret(
  node: Node,
  offset: number,
  line: HTMLElement,
  origin: HTMLElement,
  rowEnd = false,
): CaretBox {
  let rect = caretViewportRect(node, offset, rowEnd);
  const isCode = line.classList.contains('code-line');
  // A point beside no text (an empty cell's) gives a box, not a glyph's: the line's font sets
  // the caret's height.
  if (!rect || node.parentNode !== line || isCode || !(node instanceof Text)) {
    const style = getComputedStyle(line);
    const box = line.getBoundingClientRect();
    const height = fontTextHeight(isCode ? getComputedStyle(line.parentElement!) : style);
    const rows = lineRows(line, box, lineRowSizesOf(line, box));
    const row = lineRowAt(rows, rect ? rect.top + rect.height / 2 : box.top);
    rect = new DOMRect(
      rect?.left ?? box.left + parseFloat(style.paddingLeft),
      row.middle - height / 2,
      0,
      height,
    );
  }
  const base = origin.getBoundingClientRect();
  return { left: rect.left - base.left, top: rect.top - base.top, height: rect.height };
}

/** The pane each editor scrolls in, found on first use. */
const scrollers = new WeakMap<HTMLElement, HTMLElement>();

/** The pane `editor` scrolls in. */
export function paneOf(editor: HTMLElement): HTMLElement {
  let scroller = scrollers.get(editor);
  if (!scroller) scrollers.set(editor, (scroller = scrollerOf(editor)));
  return scroller;
}

/** Scroll the pane `editor` is in, by no more than it takes, to bring the row of a caret at
 *  `box` (relative to `origin`) inside it with `reveal`'s margin of one of the editor's
 *  rows; nothing while the caret is already inside. */
export function revealCaret(box: CaretBox, origin: HTMLElement, editor: HTMLElement): void {
  const scroller = paneOf(editor);
  const pane = scroller.getBoundingClientRect();
  const top = origin.getBoundingClientRect().top + box.top;
  if (top >= pane.top && top + box.height <= pane.bottom) return;
  const row = parseFloat(getComputedStyle(editor).lineHeight) || box.height;
  reveal(top + box.height / 2, row, scroller);
}

export class Caret {
  private readonly element = document.createElement('div');
  private readonly flagElement = document.createElement('div');
  /** The flag's marks as drawn, joined: a draw writes the flag only when they change. */
  private drawnFlag = '';
  /** The bar's width as last written, CSS px: it changes only with the device pixel ratio. */
  private drawnWidth = 0;
  private frame = 0;
  private blinkPhase = false;
  private restartPending = false;
  private followPending = false;

  constructor(
    wrap: HTMLElement,
    private readonly locate: () => CaretBox | null,
    private readonly timings: KeystrokeTimings,
    /** Drawn in the same frame: the selection's highlight. */
    private readonly paint: () => void = () => {},
    /** Asked by `follow`, with the caret's box (null with a selection, or none in the editor). */
    private readonly reveal: (box: CaretBox | null) => void = () => {},
    /** The flag's marks (H2, B, I…), read when the caret draws; none hide it. */
    private readonly flag: () => readonly string[] = () => [],
  ) {
    this.element.className = 'desktop-caret';
    this.element.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('div');
    bar.className = 'desktop-caret-bar';
    this.flagElement.className = 'desktop-caret-flag';
    this.flagElement.hidden = true;
    this.element.append(bar, this.flagElement);
    wrap.append(this.element);
  }

  /** Redraw on the next frame; the draw after an input counts toward its keystroke time. */
  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const began = performance.now();
      this.draw();
      this.timings.caret(performance.now() - began);
    });
  }

  /** Anything the person does (a key, a click, an edit, focus) shows the caret solid and
   *  starts its blink over. Several in one frame restart it once. */
  restartBlink(): void {
    this.restartPending = true;
    this.schedule();
  }

  /** After an edit: on the next draw, bring the caret's row into the pane (see `reveal`),
   *  whether or not the window has focus. */
  follow(): void {
    this.followPending = true;
    this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
  }

  private draw(): void {
    this.paint();
    const following = this.followPending;
    this.followPending = false;
    const located = following || document.hasFocus() ? this.locate() : null;
    if (following) this.reveal(located);
    const box = document.hasFocus() ? located : null;
    this.element.hidden = box === null;
    if (!box) return;
    const drawn = snapCaretToDevicePixels(box, window.devicePixelRatio || 1);
    if (drawn.width !== this.drawnWidth) {
      this.drawnWidth = drawn.width;
      this.element.style.width = `${drawn.width}px`;
    }
    this.element.style.transform = `translate(${drawn.left}px, ${drawn.top}px)`;
    this.element.style.height = `${drawn.height}px`;
    this.drawFlag(this.flag());
    if (!this.restartPending) return;
    this.restartPending = false;
    // Switching between two identical animations restarts the blink.
    this.blinkPhase = !this.blinkPhase;
    this.element.dataset.blink = this.blinkPhase ? 'a' : 'b';
  }

  /** One span per mark, each drawn in its own format (a struck S, a monospace <>). */
  private drawFlag(marks: readonly string[]): void {
    const joined = marks.join(' ');
    if (joined === this.drawnFlag) return;
    this.drawnFlag = joined;
    this.flagElement.hidden = marks.length === 0;
    this.flagElement.replaceChildren(
      ...marks.map((mark) => {
        const span = document.createElement('span');
        span.textContent = mark;
        span.dataset.mark = mark;
        return span;
      }),
    );
  }
}
