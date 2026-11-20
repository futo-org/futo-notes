// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Caret, measureCaret } from './caret';
import { KeystrokeTimings } from './timings';

describe('Caret blink', () => {
  afterEach(() => vi.restoreAllMocks());

  function drawnCaret() {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const wrap = document.createElement('div');
    const caret = new Caret(wrap, () => ({ left: 1, top: 2, height: 3 }), new KeystrokeTimings());
    const element = wrap.querySelector<HTMLElement>('.desktop-caret')!;
    const frame = () => frames.splice(0).forEach((callback) => callback(0));
    return { caret, element, frame };
  }

  it('restarts once however many things happened in the frame', () => {
    const { caret, element, frame } = drawnCaret();
    caret.restartBlink();
    frame();
    const first = element.dataset.blink;
    // A keystroke asks twice (keydown, then its selection change): still one restart.
    caret.restartBlink();
    caret.restartBlink();
    frame();
    expect(element.dataset.blink).not.toBe(first);
  });

  it('does not restart the blink on a redraw that nothing caused', () => {
    const { caret, element, frame } = drawnCaret();
    caret.restartBlink();
    frame();
    const blink = element.dataset.blink;
    caret.schedule();
    frame();
    expect(element.dataset.blink).toBe(blink);
    // The bar, 2px wide at 1x, centred on the point at x 1.
    expect(element.style.transform).toBe('translate(0px, 2px)');
    expect(element.style.width).toBe('2px');
  });
});

describe('measureCaret beside a picture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  /** A line of one picture, `pictureHeight` tall, under a 4px gap (a picture line's padding). */
  function pictureLine(pictureHeight: number): HTMLElement {
    const line = document.createElement('div');
    line.style.lineHeight = '24px';
    line.style.paddingTop = '4px';
    line.style.fontFamily = 'monospace';
    const image = document.createElement('span');
    image.className = 'atom image';
    image.append('![](a.png)', document.createElement('img'));
    image.getBoundingClientRect = () => new DOMRect(10, 104, 50, pictureHeight);
    line.append(image);
    // jsdom computes no style for an element outside the document.
    document.body.append(line);
    line.getBoundingClientRect = () => new DOMRect(0, 100, 400, 4 + Math.max(pictureHeight, 24));
    return line;
  }

  it('makes the caret beside a picture as tall as the picture, a text line tall by one not loaded', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const origin = document.createElement('div');
    origin.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
    for (const [pictureHeight, caretHeight] of [
      [200, 200],
      [0, 24],
    ]) {
      const line = pictureLine(pictureHeight);
      expect(measureCaret(line, 1, line, origin), `${pictureHeight}px`).toEqual({
        left: 60,
        top: 104,
        height: caretHeight,
      });
      expect(measureCaret(line, 0, line, origin), `${pictureHeight}px`).toEqual({
        left: 10,
        top: 104,
        height: caretHeight,
      });
    }
  });

  it('makes the caret in text that touches a picture on its row as tall as the picture', () => {
    const origin = document.createElement('div');
    origin.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
    const line = pictureLine(200);
    const text = document.createTextNode(' after');
    line.append(text);
    // The text's glyph box: at the picture's right edge, on the row's first line unit.
    const glyph = vi.fn(() => [new DOMRect(60, 106, 0, 20)]);
    const measure = Range.prototype.getClientRects;
    Range.prototype.getClientRects = glyph as unknown as Range['getClientRects'];
    try {
      expect(measureCaret(text, 0, line, origin)).toEqual({ left: 60, top: 104, height: 200 });
      // Away from the picture, and on a row above it, the caret is the text's own.
      expect(measureCaret(text, 3, line, origin).height).toBe(20);
      glyph.mockReturnValue([new DOMRect(60, 80, 0, 20)]);
      expect(measureCaret(text, 0, line, origin)).toEqual({ left: 60, top: 80, height: 20 });
    } finally {
      Range.prototype.getClientRects = measure;
    }
  });
});
