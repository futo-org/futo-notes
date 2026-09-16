/**
 * Turns a pairing payload into something an `<svg>` can draw.
 *
 * The only shell-side part of pairing on desktop (ADR 0003, decision 11): Rust
 * hands over a payload string and this draws it. Nothing here reads the
 * payload's shape — a QR code is bytes in, black-and-white squares out — so a
 * change to what the payload carries never reaches this file.
 *
 * The result is a single SVG path rather than one rectangle per square,
 * because a real payload comes out as a 61×61 grid and three thousand DOM
 * nodes to draw a static picture is a waste of a layout pass.
 */

import { encode } from 'uqr';

export interface QrCodeDrawing {
  /** The grid's width in squares, INCLUDING the quiet border. This is the
      `viewBox` side, so one square is one user unit. */
  size: number;
  /** An SVG path's `d`, one `M…h…v…h…z` box per black square. */
  path: string;
}

/**
 * A payload as a drawable grid.
 *
 * Error correction is `M`: a screen is not a printed label, but a phone camera
 * reads it at an angle, off a display with its own glare and scaling, so the
 * cheapest level is not the right one. The border is the four-square quiet
 * zone the QR spec asks for — without it a scanner cannot find the code
 * against whatever is next to it.
 */
export function qrCodeDrawing(payload: string): QrCodeDrawing {
  const { size, data } = encode(payload, { ecc: 'M', border: 4 });
  const boxes: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (data[row][column]) boxes.push(`M${column} ${row}h1v1h-1z`);
    }
  }
  return { size, path: boxes.join('') };
}
