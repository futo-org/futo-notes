import {
  countPerfEvents,
  drainPerfEvents,
  startFrameProbe,
  stopFrameProbe,
  type PerfEvent,
} from './perfEvents';

export interface PerfCourseApi {
  drain(): PerfEvent[];
  count(): number;
  startFrameProbe(): void;
  stopFrameProbe(): { frames: number; deltasMs: number[] };
}

declare global {
  interface Window {
    __perfCourse?: PerfCourseApi;
  }
}

// Debug-only readout for an external perf measurement harness. The collector
// itself is always on; only this window hook is gated (installed from
// installDevelopmentHooks, same DEV/VITE_INCLUDE_TEST_HOOKS gate as
// __testSync).
export function installPerfCourse(target: Window = window): void {
  target.__perfCourse = {
    drain: drainPerfEvents,
    count: countPerfEvents,
    startFrameProbe,
    stopFrameProbe,
  };
}
