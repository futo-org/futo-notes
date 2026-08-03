let pointersDown = 0;
let waiters: Array<() => void> = [];
let fallbackTimer: number | null = null;

function clearFallback(): void {
  if (fallbackTimer === null) return;
  clearTimeout(fallbackTimer);
  fallbackTimer = null;
}

function disarm(): void {
  clearFallback();
  window.removeEventListener('click', onClick, true);
}

function runWaiters(): void {
  disarm();
  // A fresh press can begin inside the fallback window. Committing now would
  // move the list under THAT gesture; keep the queue, the next release re-arms.
  if (pointersDown > 0) return;
  const pending = waiters;
  waiters = [];
  for (const run of pending) run();
}

// A task, not a microtask: `click` dispatches after `pointerup`, so the work
// has to land past the whole click — including the target's own handler.
function onClick(): void {
  clearFallback();
  setTimeout(runWaiters, 0);
}

function onPointerDown(): void {
  pointersDown += 1;
}

function onRelease(): void {
  pointersDown = Math.max(0, pointersDown - 1);
  if (pointersDown > 0 || waiters.length === 0) return;
  // A gesture usually ends in a click; drain right after it. A drag or a
  // cancel never delivers one, so a short fallback keeps work from stranding.
  window.addEventListener('click', onClick, { capture: true, once: true });
  fallbackTimer = window.setTimeout(runWaiters, 100);
}

// A release outside the window is never delivered, which would strand the
// count above zero and every queued commit with it until a reload.
function onWindowBlur(): void {
  pointersDown = 0;
  runWaiters();
}

function install(): void {
  window.addEventListener('pointerdown', onPointerDown, { capture: true });
  window.addEventListener('pointerup', onRelease, { capture: true });
  window.addEventListener('pointercancel', onRelease, { capture: true });
  window.addEventListener('blur', onWindowBlur);
}

function uninstall(): void {
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('pointerup', onRelease, true);
  window.removeEventListener('pointercancel', onRelease, true);
  window.removeEventListener('blur', onWindowBlur);
  disarm();
}

if (typeof window !== 'undefined') {
  // Installed at import, NOT on first use: the first caller is itself a blur
  // handler running inside a pointer press, so a lazy install would miss the
  // very `pointerdown` it needs to know about and run the work immediately.
  install();
  // Without this an HMR update leaves the old listeners attached, so every
  // press counts twice and the count never returns to zero.
  import.meta.hot?.dispose(uninstall);
}

/**
 * Runs `fn` once no pointer button is held — immediately when none is.
 *
 * For work that moves elements the in-flight gesture is about to act on. A
 * pointer press fires `blur` before `pointerup`/`click`, so reordering a list
 * from a blur handler swaps the element under the cursor and the click lands
 * on whatever slid into its place.
 */
export function runWhenPointerIdle(fn: () => void): void {
  if (pointersDown === 0) {
    fn();
    return;
  }
  waiters.push(fn);
}

/** Test seam: forget any held pointer and pending waiters. */
export function _resetPointerGestureForTest(): void {
  pointersDown = 0;
  waiters = [];
  disarm();
}
