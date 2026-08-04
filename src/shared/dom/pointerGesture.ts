let pointersDown = 0;
let dragging = false;
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
  // A fresh gesture can start inside the window this one armed; its release re-arms.
  if (pointersDown > 0 || dragging) return;
  const pending = waiters;
  waiters = [];
  for (const run of pending) run();
}

// A task, not a microtask: the work has to land past the click target's own handler.
function onClick(): void {
  clearFallback();
  setTimeout(runWaiters, 0);
}

function onPointerDown(): void {
  // A press cannot start mid-drag, so this also recovers a lost `dragend`.
  dragging = false;
  pointersDown += 1;
}

function onDragStart(): void {
  dragging = true;
}

// Releases no pointer: `pointercancel` already accounted for the one the drag took.
function onDragEnd(): void {
  dragging = false;
  armDrain();
}

function onRelease(): void {
  pointersDown = Math.max(0, pointersDown - 1);
  armDrain();
}

function armDrain(): void {
  // `dragstart` cancels the pointer, but the drop still acts on the id captured
  // when the drag began — a drag's release is `dragend`, which fires after `drop`.
  if (dragging || pointersDown > 0 || waiters.length === 0) return;
  clearFallback();
  window.addEventListener('click', onClick, { capture: true, once: true });
  fallbackTimer = window.setTimeout(runWaiters, 100);
}

// A release outside the window is never delivered, stranding the count above zero.
function onWindowBlur(): void {
  pointersDown = 0;
  runWaiters();
}

function install(): void {
  window.addEventListener('pointerdown', onPointerDown, { capture: true });
  window.addEventListener('pointerup', onRelease, { capture: true });
  window.addEventListener('pointercancel', onRelease, { capture: true });
  window.addEventListener('dragstart', onDragStart, { capture: true });
  window.addEventListener('dragend', onDragEnd, { capture: true });
  window.addEventListener('blur', onWindowBlur);
}

function uninstall(): void {
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('pointerup', onRelease, true);
  window.removeEventListener('pointercancel', onRelease, true);
  window.removeEventListener('dragstart', onDragStart, true);
  window.removeEventListener('dragend', onDragEnd, true);
  window.removeEventListener('blur', onWindowBlur);
  disarm();
}

if (typeof window !== 'undefined') {
  // At import, not lazily: the first caller is a blur handler already inside a
  // press, so it would miss the `pointerdown` it needs.
  install();
  // Otherwise HMR leaves the old listeners attached and every press counts twice.
  import.meta.hot?.dispose(uninstall);
}

/**
 * Runs `fn` once no pointer gesture is in flight — immediately when none is.
 * `blur` fires on pointer-DOWN, so reordering a list from a blur handler swaps
 * the element under the cursor.
 */
export function runWhenPointerIdle(fn: () => void): void {
  if (pointersDown === 0) {
    fn();
    return;
  }
  waiters.push(fn);
}

export function _resetPointerGestureForTest(): void {
  pointersDown = 0;
  dragging = false;
  waiters = [];
  disarm();
}
