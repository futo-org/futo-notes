/**
 * Scroll jank detector. Measures frame times via rAF and logs when frames
 * exceed the 16.6ms budget (60fps). Also provides a timer utility to
 * instrument specific code paths.
 *
 * Logs go to console.warn → visible in `adb logcat | grep -i jank`
 */

let enabled = false;
let lastFrameTime = 0;
let rafId = 0;
const FRAME_BUDGET = 16.67; // ms for 60fps
const JANK_THRESHOLD = 18; // log any frame over 1 frame budget (ms)

function frameLoop(now: number): void {
  if (!enabled) return;

  if (lastFrameTime > 0) {
    const frameDuration = now - lastFrameTime;
    if (frameDuration > JANK_THRESHOLD) {
      console.warn(
        `[JANK] Frame took ${frameDuration.toFixed(1)}ms (budget: ${FRAME_BUDGET.toFixed(1)}ms, dropped ~${Math.floor(frameDuration / FRAME_BUDGET) - 1} frames)`
      );
    }
  }

  lastFrameTime = now;
  rafId = requestAnimationFrame(frameLoop);
}

export function startJankMonitor(): void {
  if (enabled) return;
  enabled = true;
  lastFrameTime = 0;
  console.warn('[JANK] Monitor started — threshold: >' + JANK_THRESHOLD + 'ms');
  rafId = requestAnimationFrame(frameLoop);
}

export function stopJankMonitor(): void {
  enabled = false;
  cancelAnimationFrame(rafId);
  console.warn('[JANK] Monitor stopped');
}

/**
 * Time a named operation. Logs if it exceeds 2ms.
 * Usage: const end = timeOp('buildDecorations'); ... end();
 */
export function timeOp(name: string): () => void {
  const start = performance.now();
  return () => {
    const duration = performance.now() - start;
    if (duration > 2) {
      console.warn(`[PERF] ${name}: ${duration.toFixed(2)}ms`);
    }
  };
}
