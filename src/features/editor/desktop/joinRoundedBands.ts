import type { Band } from './highlight';

/** A band that fills a rounded object, a code block's card or a picture: the class that rounds
 *  it as that object is rounded, and each corner square (true) or rounded. */
export interface RoundedCorners {
  shape: 'code-card' | 'picture-band';
  topLeft: boolean;
  topRight: boolean;
  bottomRight: boolean;
  bottomLeft: boolean;
}

/** Half a pixel either way: rows meet at fractional heights. */
const TOUCH_TOLERANCE = 0.5;

const bottomOf = (band: Band): number => band.top + band.height;
const rightOf = (band: Band): number => band.left + band.width;
const reachTopOf = (band: Band): number => band.reach?.top ?? band.top;
const reachBottomOf = (band: Band): number => band.reach?.bottom ?? bottomOf(band);
const near = (one: number, other: number): boolean => Math.abs(one - other) <= TOUCH_TOLERANCE;

function coversX(band: Band, x: number): boolean {
  return band.left <= x + TOUCH_TOLERANCE && rightOf(band) >= x - TOUCH_TOLERANCE;
}

function coversY(band: Band, y: number): boolean {
  return band.top <= y + TOUCH_TOLERANCE && bottomOf(band) >= y - TOUCH_TOLERANCE;
}

/** The room between `upper` and the band `lower` under it, over the width they share; null
 *  where they share none or touch. */
function roomBetween(upper: Band, lower: Band): Band | null {
  const left = Math.max(upper.left, lower.left);
  const right = Math.min(rightOf(upper), rightOf(lower));
  const gap = lower.top - bottomOf(upper);
  if (right - left <= TOUCH_TOLERANCE || gap <= TOUCH_TOLERANCE) return null;
  return { left, top: bottomOf(upper), width: right - left, height: gap };
}

/** `bands` joined where a rounded one meets another: a corner is square where the band it
 *  meets covers it (the band above or below over the corner's x, the band beside it over its
 *  y), so the selection runs on past the corner without a notch of page; a corner with nothing
 *  selected beyond it stays as it was. Bands meet where they touch, or where a picture's reach
 *  (its line's room above or below it) touches the other: the room between them is filled over
 *  the width they share. Two touching cards stand apart by a margin (page, not block), so they
 *  never meet and their facing corners stay rounded. */
export function joinRoundedBands(bands: readonly Band[]): Band[] {
  const joined = bands.map((band) =>
    band.rounded ? { ...band, rounded: { ...band.rounded } } : band,
  );
  const rooms: Band[] = [];
  for (const band of joined) {
    const rounded = band.rounded;
    if (!rounded) continue;
    for (const other of joined) {
      if (other === band) continue;
      // A room between two rounded bands is filled once, from the lower one's side.
      if (near(reachBottomOf(other), reachTopOf(band))) {
        rounded.topLeft ||= coversX(other, band.left);
        rounded.topRight ||= coversX(other, rightOf(band));
        const room = roomBetween(other, band);
        if (room) rooms.push(room);
      }
      if (near(reachBottomOf(band), reachTopOf(other))) {
        rounded.bottomRight ||= coversX(other, rightOf(band));
        rounded.bottomLeft ||= coversX(other, band.left);
        const room = other.rounded ? null : roomBetween(band, other);
        if (room) rooms.push(room);
      }
      if (near(rightOf(other), band.left)) {
        rounded.topLeft ||= coversY(other, band.top);
        rounded.bottomLeft ||= coversY(other, bottomOf(band));
      }
      if (near(other.left, rightOf(band))) {
        rounded.topRight ||= coversY(other, band.top);
        rounded.bottomRight ||= coversY(other, bottomOf(band));
      }
    }
  }
  return [...joined, ...rooms];
}
