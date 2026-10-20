/*
 * The interaction hold: background idle work yields to the user's touch.
 *
 * A progressive open streams its tail in idle slices, and the serializer
 * primes its cache the same way (progressiveLoad.ts, serializationLoop.ts).
 * `requestIdleCallback` has a 200 ms timeout so a busy page cannot starve the
 * stream — which means that on a slow phone, where the frames after a tap or
 * a focus are already long (caret placement, the editable's focus work, the
 * keyboard inset relayout), the timeout fires INSIDE that window and parks a
 * chunk parse between the finger and the caret. Measured 2026-10-08
 * (docs/perf/note-open-focus.md): the first tap into a still-streaming note.
 *
 * So the hold watches the one signal that the next frames belong to the user —
 * a pointer down, a focus, a key — and reports "held" for a short settle window
 * after each one. The yielding scheduler (`createYieldingIdleScheduler` in
 * progressiveLoad.ts) waits a frame at a time while held, then schedules the
 * slice as before. Nothing is canceled and nothing is reordered: a slice that
 * was due runs as soon as the hold lifts, so the stream's exactly-once
 * completion and the save lock behind it are untouched.
 *
 * Two bounds keep this from starving the stream:
 *   - the hold is a SETTLE window after the last event (`settleMs`), not an
 *     open-ended "while interacting";
 *   - an unbroken run of events (a scroll gesture, fast typing) can hold for at
 *     most `maxHoldMs`; after that it does not hold again until the events
 *     pause for a settle window, so a slice always gets through.
 *
 * Per event the cost is two number writes (M5).
 */

export interface InteractionHoldOptions {
  /** Milliseconds after the last event during which the hold stays up. */
  settleMs?: number;
  /** The longest an unbroken run of events can hold before slices run again. */
  maxHoldMs?: number;
  /** Injected for tests. */
  now?: () => number;
}

export interface InteractionHold {
  /** Whether idle work should wait for the user right now. */
  isHeld: () => boolean;
  /** Note an interaction at `now()`. */
  touch: () => void;
  /** Watch `target` for the user's pointer, focus and keys; returns the detach. */
  attach: (target: EventTarget) => () => void;
}

/** A tap's layout work lands in the next few frames; on a budget phone those are long. */
export const HOLD_SETTLE_MS = 150;
/** An unbroken gesture yields to the stream after this long. */
export const HOLD_MAX_MS = 1_000;

/** The DOM events that say "the next frames are the user's". Capture-phase, passive. */
const HOLD_EVENTS = ['pointerdown', 'focusin', 'keydown'] as const;

export function createInteractionHold(options: InteractionHoldOptions = {}): InteractionHold {
  const {
    settleMs = HOLD_SETTLE_MS,
    maxHoldMs = HOLD_MAX_MS,
    now = () => performance.now(),
  } = options;
  /** When the current unbroken run of events began. */
  let runStartedAt = -Infinity;
  let lastEventAt = -Infinity;
  /** The current run has used its whole `maxHoldMs`; it holds no more. */
  let exhausted = false;

  function isHeld(): boolean {
    const t = now();
    // A pause ends the run, exhausted or not.
    if (t - lastEventAt >= settleMs) return false;
    if (exhausted) return false;
    if (t - runStartedAt >= maxHoldMs) {
      exhausted = true;
      return false;
    }
    return true;
  }

  function touch(): void {
    const t = now();
    if (t - lastEventAt >= settleMs) {
      // A fresh run after a pause: a fresh max-hold clock.
      runStartedAt = t;
      exhausted = false;
    }
    lastEventAt = t;
  }

  function attach(target: EventTarget): () => void {
    const listener = (): void => touch();
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of HOLD_EVENTS) target.addEventListener(type, listener, opts);
    return () => {
      for (const type of HOLD_EVENTS) target.removeEventListener(type, listener, opts);
    };
  }

  return { isHeld, touch, attach };
}
