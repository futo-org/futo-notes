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

  it('stands the caret after a picture on its row first line unit, a text line tall', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const origin = document.createElement('div');
    origin.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
    for (const height of [200, 0]) {
      const line = pictureLine(height);
      expect(measureCaret(line, 1, line, origin), `${height}px`).toEqual({
        left: 60,
        top: 104,
        height: 24,
      });
      expect(measureCaret(line, 0, line, origin).left).toBe(10);
    }
  });
});
