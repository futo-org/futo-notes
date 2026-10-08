// Phase timeline for one note switch (Ctrl+Tab, tab click, sidebar click, deep
// link). A switch spans two owners — createTabNoteTransition in app/ and
// createNoteLoader in features/notes/ — and features/ cannot import from app/,
// so the timeline lives at their nearest common owner rather than in either.
//
// These are thin names over the interaction ledger (interactionLedger.ts),
// kept so the two owners and the tab-switch probe
// (scripts/perf/tab-switch-probe.js, via `__notesShellTest`) read as before.
// It deliberately does NOT touch the per-keystroke path (M5).

import {
  beginInteraction,
  clearInteractions,
  endInteraction,
  getInteractions,
  markInteraction,
} from './interactionLedger';

export type NoteSwitchPhase =
  'saveFlushed' | 'readStarted' | 'noteRead' | 'contentApplied' | 'loadReturned' | 'scrollRestored';

export interface NoteSwitchTimeline {
  noteId: string | null;
  /** performance.now() when the switch was requested. */
  startedAt: number;
  /** Milliseconds from startedAt to each phase that ran, in the order they ran. */
  phases: Array<{ phase: NoteSwitchPhase; atMs: number }>;
}

export function beginNoteSwitch(noteId: string | null): void {
  beginInteraction('note-switch', noteId);
}

export function markNoteSwitch(phase: NoteSwitchPhase): void {
  markInteraction('note-switch', phase);
}

/**
 * Ends the current switch. A superseded switch (the user pressed Ctrl+Tab again
 * mid-load) simply stops receiving marks; its timeline stays as recorded so a
 * dropped phase is visible rather than silently attributed to the next switch.
 */
export function endNoteSwitch(): void {
  endInteraction('note-switch');
}

export function getNoteSwitchTimelines(): readonly NoteSwitchTimeline[] {
  return getInteractions('note-switch').map((record) => ({
    noteId: record.subject,
    startedAt: record.startedAt,
    phases: record.phases as NoteSwitchTimeline['phases'],
  }));
}

export function clearNoteSwitchTimelines(): void {
  clearInteractions('note-switch');
}
