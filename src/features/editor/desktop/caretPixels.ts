import type { CaretBox } from './caret';

/** The caret bar's width at 1x, CSS px; drawn as the nearest whole number of device pixels. */
export const CARET_NOMINAL_WIDTH = 2;

/** A caret box as drawn: its bar's left edge, top, width and height, CSS px relative to the
 *  caret's parent. */
export interface DrawnCaret {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `box` (the caret's point and row, relative to its parent) with every edge on a whole device
 *  pixel at `devicePixelRatio`, the bar centred on the point. WebKit and Chromium both paint a
 *  transformed element from its layout origin rounded to a device pixel, then apply the
 *  transform as given: so a translate of whole device pixels lands on whole device pixels
 *  however fractionally the parent sits, and needs no read of where the parent is. */
export function snapCaretToDevicePixels(box: CaretBox, devicePixelRatio: number): DrawnCaret {
  const snap = (cssPixels: number): number =>
    Math.round(cssPixels * devicePixelRatio) / devicePixelRatio;
  const width = Math.max(1, Math.round(CARET_NOMINAL_WIDTH * devicePixelRatio)) / devicePixelRatio;
  const top = snap(box.top);
  return {
    left: snap(box.left - width / 2),
    top,
    width,
    height: snap(box.top + box.height) - top,
  };
}
