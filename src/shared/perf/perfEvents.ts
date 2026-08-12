// Always-on, bounded perf-event collector read by the desktop performance
// harness, which lives outside this repo's test suite and attaches through the
// window hook below. Recording must stay trivially cheap because
// callers emit on every note open / search / startup; the ring-buffer cap is
// the safety that lets it run unconditionally in production builds. The
// harness reads it through the dev-gated window.__perfCourse hook
// (installPerfCourse.ts).

export interface PerfEvent {
  name: string;
  startMs: number;
  durationMs: number;
  detail?: string;
}

export type EndPerfSpan = (extraDetail?: string) => void;

const MAX_BUFFERED_EVENTS = 500;
const MAX_FRAME_DELTA_SAMPLES = 10000;

const bufferedEvents: PerfEvent[] = [];

export function recordPerfEvent(name: string, durationMs: number, detail?: string): void {
  const event: PerfEvent = { name, startMs: performance.now() - durationMs, durationMs };
  if (detail !== undefined) event.detail = detail;
  bufferedEvents.push(event);
  // Bounded ring: drop the oldest event rather than grow without limit.
  if (bufferedEvents.length > MAX_BUFFERED_EVENTS) bufferedEvents.shift();
}

// Returns an `end` function that records the span. Ending twice is a no-op;
// a span that never ends (superseded load, stale search response) records
// nothing, so cancelled work can never contaminate the numbers.
export function beginPerfSpan(name: string, detail?: string): EndPerfSpan {
  const spanStartMs = performance.now();
  let ended = false;
  return (extraDetail?: string) => {
    if (ended) return;
    ended = true;
    const combinedDetail =
      detail !== undefined && extraDetail !== undefined
        ? `${detail} ${extraDetail}`
        : (extraDetail ?? detail);
    recordPerfEvent(name, performance.now() - spanStartMs, combinedDetail);
  };
}

export function drainPerfEvents(): PerfEvent[] {
  return bufferedEvents.splice(0, bufferedEvents.length);
}

export function countPerfEvents(): number {
  return bufferedEvents.length;
}

let frameProbeHandle: number | null = null;
let frameProbeFrames = 0;
let frameProbeDeltasMs: number[] = [];
let lastFrameTimeMs: number | null = null;

// requestAnimationFrame loop recording inter-frame deltas, for runner-side
// jank measurement while it exercises the app. Starting while already
// running restarts the probe; stopping while not running returns empty.
export function startFrameProbe(): void {
  if (frameProbeHandle !== null) cancelAnimationFrame(frameProbeHandle);
  frameProbeFrames = 0;
  frameProbeDeltasMs = [];
  lastFrameTimeMs = null;
  const onFrame = (frameTimeMs: number) => {
    frameProbeFrames += 1;
    if (lastFrameTimeMs !== null && frameProbeDeltasMs.length < MAX_FRAME_DELTA_SAMPLES) {
      frameProbeDeltasMs.push(frameTimeMs - lastFrameTimeMs);
    }
    lastFrameTimeMs = frameTimeMs;
    frameProbeHandle = requestAnimationFrame(onFrame);
  };
  frameProbeHandle = requestAnimationFrame(onFrame);
}

export function stopFrameProbe(): { frames: number; deltasMs: number[] } {
  if (frameProbeHandle === null) return { frames: 0, deltasMs: [] };
  cancelAnimationFrame(frameProbeHandle);
  frameProbeHandle = null;
  const result = { frames: frameProbeFrames, deltasMs: frameProbeDeltasMs };
  frameProbeFrames = 0;
  frameProbeDeltasMs = [];
  lastFrameTimeMs = null;
  return result;
}
