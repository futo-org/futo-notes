/// Radians of turn per pixel dragged. Tuned so crossing a 96px coin turns it
/// about half a revolution: enough that a drag obviously grabs the object,
/// little enough that you can stop on a face.
const DRAG_RADIANS_PER_PIXEL = 0.018;
/// A flick is only a flick if the pointer was still moving when it left. Below
/// this the coin is *placed*, and it stays where it was put until it eases back
/// to its resting speed.
const FLICK_MIN_SPEED = 0.6;
/// Ceiling on a thrown spin, so a fast swipe across a trackpad cannot turn the
/// coin into a strobe.
const FLICK_MAX_SPEED = 24;

/// A press is a click and not a drag if the pointer barely moved and did not
/// linger. Both bounds matter: a 2px wobble is still a click, and a slow,
/// deliberate 2px nudge that holds for a second is not.
const TAP_MAX_MOVEMENT_PX = 5;
const TAP_MAX_MILLISECONDS = 400;

/// What a drag does to the thing being turned.
export interface TurnTarget {
  grab(): void;
  turnBy(radians: number): void;
  /// Angular velocity in rad/s for a flick, or `null` when the coin was placed
  /// rather than thrown.
  release(thrown: number | null): void;
  /// The pointer went down and came back up without really moving: a click.
  /// Always preceded by `grab()` and `release(null)`, since a click is a drag
  /// that went nowhere.
  tap(): void;
}

/// Makes an element's contents turn under a mouse, pen or finger, and returns
/// the detach function.
///
/// Pointer events cover all three input kinds in one path, and pointer capture
/// means a drag that wanders off the element keeps tracking instead of
/// sticking. `touch-action: pan-y` is a deliberate half-measure: a vertical
/// swipe still scrolls the Settings sheet under the finger, a horizontal one
/// turns the coin. Claiming the whole gesture would trap the scroll on a phone.
export function attachDragToTurn(mount: HTMLElement, target: TurnTarget): () => void {
  let pointer = -1;
  let lastX = 0;
  let lastMoveAt = 0;
  /// Distance travelled and when the press began — together they separate a
  /// click from a drag that happened to end where it started.
  let travelled = 0;
  let pressedAt = 0;
  /// Radians/second, smoothed — a single sample is noisy enough to throw a wild
  /// flick off the last two pixels of an otherwise slow drag.
  let velocity = 0;

  mount.style.touchAction = 'pan-y';
  // The cursor is NOT set here. `src/styles/desktop-native.css` owns cursor
  // policy for the whole desktop shell with a layered `!important` sweep, so an
  // inline cursor silently loses to it; the grab/grabbing pair is declared
  // there, keyed off this attribute.
  mount.dataset.turning = 'false';

  function onPointerDown(event: PointerEvent): void {
    if (pointer !== -1) return;
    pointer = event.pointerId;
    lastX = event.clientX;
    lastMoveAt = event.timeStamp;
    pressedAt = event.timeStamp;
    travelled = 0;
    velocity = 0;
    // Capture keeps a drag tracking after it wanders off the coin. It throws
    // for a pointer id the browser does not consider active — a synthetic
    // event from a test, or a pointer already released — and losing capture is
    // not worth losing the drag over.
    try {
      mount.setPointerCapture(event.pointerId);
    } catch {
      /* drag still works, it just stops at the element's edge */
    }
    mount.dataset.turning = 'true';
    target.grab();
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== pointer) return;
    const dx = event.clientX - lastX;
    const seconds = (event.timeStamp - lastMoveAt) / 1000;
    lastX = event.clientX;
    lastMoveAt = event.timeStamp;
    travelled += Math.abs(dx);
    const radians = dx * DRAG_RADIANS_PER_PIXEL;
    target.turnBy(radians);
    if (seconds > 0) velocity = velocity * 0.7 + (radians / seconds) * 0.3;
  }

  function endDrag(event: PointerEvent): void {
    if (event.pointerId !== pointer) return;
    pointer = -1;
    mount.dataset.turning = 'false';
    // A stale sample would fling a coin the user had deliberately held still,
    // so a pointer that had stopped before it lifted counts as a placement.
    const stale = event.timeStamp - lastMoveAt > 100;
    const thrown = !stale && Math.abs(velocity) > FLICK_MIN_SPEED;
    target.release(thrown ? Math.max(-FLICK_MAX_SPEED, Math.min(FLICK_MAX_SPEED, velocity)) : null);
    // After `release`, so the turn starts from a coin that is already back
    // under its own control.
    if (travelled <= TAP_MAX_MOVEMENT_PX && event.timeStamp - pressedAt <= TAP_MAX_MILLISECONDS) {
      target.tap();
    }
  }

  mount.addEventListener('pointerdown', onPointerDown);
  mount.addEventListener('pointermove', onPointerMove);
  mount.addEventListener('pointerup', endDrag);
  mount.addEventListener('pointercancel', endDrag);

  return () => {
    mount.removeEventListener('pointerdown', onPointerDown);
    mount.removeEventListener('pointermove', onPointerMove);
    mount.removeEventListener('pointerup', endDrag);
    mount.removeEventListener('pointercancel', endDrag);
  };
}
