// Phase timeline for one note switch (Ctrl+Tab, tab click, sidebar click, deep
// link). A switch spans two owners — createTabNoteTransition in app/ and
// createNoteLoader in features/notes/ — and features/ cannot import from app/,
// so the timeline lives at their nearest common owner rather than in either.
//
// Always on. A phase costs one performance.now() and one array write, and only
// the last HISTORY switches are retained, so this never grows without bound.
// It deliberately does NOT touch the per-keystroke path (M5).

export type NoteSwitchPhase =
  'saveFlushed' | 'readStarted' | 'noteRead' | 'contentApplied' | 'loadReturned' | 'scrollRestored';

export interface NoteSwitchTimeline {
  noteId: string | null;
  /** performance.now() when the switch was requested. */
  startedAt: number;
  /** Milliseconds from startedAt to each phase that ran, in the order they ran. */
  phases: Array<{ phase: NoteSwitchPhase; atMs: number }>;
}

const HISTORY = 50;

const timelines: NoteSwitchTimeline[] = [];
let current: NoteSwitchTimeline | null = null;

export function beginNoteSwitch(noteId: string | null): void {
  current = { noteId, startedAt: performance.now(), phases: [] };
  timelines.push(current);
  if (timelines.length > HISTORY) timelines.shift();
}

export function markNoteSwitch(phase: NoteSwitchPhase): void {
  if (!current) return;
  current.phases.push({ phase, atMs: performance.now() - current.startedAt });
}

/**
 * Ends the current switch. A superseded switch (the user pressed Ctrl+Tab again
 * mid-load) simply stops receiving marks; its timeline stays as recorded so a
 * dropped phase is visible rather than silently attributed to the next switch.
 */
export function endNoteSwitch(): void {
  current = null;
}

export function getNoteSwitchTimelines(): readonly NoteSwitchTimeline[] {
  return timelines;
}

export function clearNoteSwitchTimelines(): void {
  timelines.length = 0;
  current = null;
}
