import {
  clearInteractions,
  getInteractions,
  keystrokeFrameSamplesMs,
  setKeystrokeTripwire,
  type InteractionKind,
  type InteractionRecord,
} from './interactionLedger';
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
  /** The interaction ledger (interactionLedger.ts): every retained record, or one kind's. */
  interactions(kind?: InteractionKind): readonly InteractionRecord[];
  clearInteractions(kind?: InteractionKind): void;
  /** The keystroke tripwire's readout: dispatch → next frame, per retained edit, in ms. */
  keystrokeFrameSamplesMs(): number[];
  setKeystrokeTripwire(enabled: boolean): void;
}

declare global {
  interface Window {
    __perfCourse?: PerfCourseApi;
  }
}

// Debug-only readout for an external perf measurement harness. The collector
// itself is always on; only this window hook is gated (installed from
// installDevelopmentHooks, same DEV/VITE_INCLUDE_TEST_HOOKS gate as
// __testSync). Installing it also turns the keystroke tripwire on — a dev or
// test build records every edit's dispatch → frame; a shipped build never
// reaches this function and pays one boolean read per edit.
export function installPerfCourse(target: Window = window): void {
  target.__perfCourse = {
    drain: drainPerfEvents,
    count: countPerfEvents,
    startFrameProbe,
    stopFrameProbe,
    interactions: getInteractions,
    clearInteractions,
    keystrokeFrameSamplesMs,
    setKeystrokeTripwire,
  };
  setKeystrokeTripwire(true);
}
