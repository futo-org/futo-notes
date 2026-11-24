import { describe, expect, it } from 'vitest';
import { CARET_NOMINAL_WIDTH, snapCaretToDevicePixels } from './caretPixels';

const RATIOS = [1, 1.25, 1.5, 1.6, 2];
// Where the caret's parent sits in the viewport, CSS px: whole, half (a scrollbar's 342.5), and
// a fraction a layout leaves.
const ORIGINS = [350, 342.5, 100.3, 57.85];
// The caret's point and row relative to its parent, as `measureCaret` gives them.
const BOXES = [
  { left: 20, top: 15.92, height: 20.16 },
  { left: 170.37, top: 63.90625, height: 30.234375 },
  { left: 0.5, top: 0, height: 24 },
];

/** Whether `devicePixels` is a whole number of device pixels, floating point allowed. */
const isWhole = (devicePixels: number): boolean =>
  Math.abs(devicePixels - Math.round(devicePixels)) < 1e-6;

describe('snapCaretToDevicePixels', () => {
  it('lands every edge on a device pixel wherever the parent sits', () => {
    for (const ratio of RATIOS) {
      for (const origin of ORIGINS) {
        // WebKit and Chromium paint a transformed element from its layout origin rounded to a
        // device pixel, then translate it as given.
        const paintedOrigin = Math.round(origin * ratio);
        for (const box of BOXES) {
          const drawn = snapCaretToDevicePixels(box, ratio);
          const left = paintedOrigin + drawn.left * ratio;
          const top = paintedOrigin + drawn.top * ratio;
          for (const edge of [left, left + drawn.width * ratio, top, top + drawn.height * ratio]) {
            expect(isWhole(edge), `ratio ${ratio}, origin ${origin}, edge ${edge}`).toBe(true);
          }
        }
      }
    }
  });

  it('keeps the nominal width at 1x and 2x and the nearest whole device pixels between', () => {
    for (const ratio of RATIOS) {
      const devicePixels = snapCaretToDevicePixels(BOXES[0], ratio).width * ratio;
      expect(isWhole(devicePixels)).toBe(true);
      expect(Math.abs(devicePixels - CARET_NOMINAL_WIDTH * ratio)).toBeLessThanOrEqual(0.5);
    }
    expect(snapCaretToDevicePixels(BOXES[0], 1).width).toBe(CARET_NOMINAL_WIDTH);
    expect(snapCaretToDevicePixels(BOXES[0], 2).width).toBe(CARET_NOMINAL_WIDTH);
  });

  it('centres the bar on the point within half a device pixel, its row kept', () => {
    for (const ratio of RATIOS) {
      for (const box of BOXES) {
        const drawn = snapCaretToDevicePixels(box, ratio);
        expect(Math.abs(drawn.left + drawn.width / 2 - box.left)).toBeLessThanOrEqual(
          0.5 / ratio + 1e-9,
        );
        expect(Math.abs(drawn.top - box.top)).toBeLessThanOrEqual(0.5 / ratio + 1e-9);
        expect(Math.abs(drawn.top + drawn.height - box.top - box.height)).toBeLessThanOrEqual(
          0.5 / ratio + 1e-9,
        );
      }
    }
  });
});
