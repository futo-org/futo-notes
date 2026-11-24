// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  beginInteraction,
  clearInteractions,
  endInteraction,
  getInteractions,
  markInteraction,
} from './interactionLedger';
import {
  beginNoteSwitch,
  clearNoteSwitchTimelines,
  endNoteSwitch,
  getNoteSwitchTimelines,
  markNoteSwitch,
} from './noteSwitchTimeline';

// Module-level singleton state, so every test starts from an empty ledger.
afterEach(() => {
  clearInteractions();
});

describe('interaction ledger', () => {
  it('records phases relative to the interaction start', () => {
    beginInteraction('note-switch', 'note-a');
    markInteraction('note-switch', 'noteRead');
    markInteraction('note-switch', 'contentApplied');
    endInteraction('note-switch');

    const [record] = getInteractions('note-switch');
    expect(record.kind).toBe('note-switch');
    expect(record.subject).toBe('note-a');
    expect(record.phases.map((p) => p.phase)).toEqual(['noteRead', 'contentApplied']);
    expect(record.phases[0].atMs).toBeGreaterThanOrEqual(0);
    expect(record.phases[1].atMs).toBeGreaterThanOrEqual(record.phases[0].atMs);
  });

  it('drops marks after end, and a superseded interaction keeps what it recorded', () => {
    beginInteraction('note-switch', 'first');
    markInteraction('note-switch', 'saveFlushed');
    beginInteraction('note-switch', 'second');
    markInteraction('note-switch', 'noteRead');
    endInteraction('note-switch');
    markInteraction('note-switch', 'contentApplied');

    const records = getInteractions('note-switch');
    expect(records.map((r) => r.subject)).toEqual(['first', 'second']);
    expect(records[0].phases.map((p) => p.phase)).toEqual(['saveFlushed']);
    expect(records[1].phases.map((p) => p.phase)).toEqual(['noteRead']);
  });

  it('is bounded: only the most recent records are retained', () => {
    for (let i = 0; i < 250; i += 1) beginInteraction('note-switch', String(i));
    const records = getInteractions('note-switch');
    expect(records).toHaveLength(100);
    expect(records[0].subject).toBe('150');
  });
});

describe('note switch timeline over the ledger', () => {
  it('keeps the shape the tab-switch probe reads: noteId, startedAt, phases', () => {
    beginNoteSwitch('note-7');
    markNoteSwitch('saveFlushed');
    markNoteSwitch('contentApplied');
    endNoteSwitch();

    const [timeline] = getNoteSwitchTimelines();
    expect(timeline.noteId).toBe('note-7');
    expect(typeof timeline.startedAt).toBe('number');
    expect(timeline.phases.map((p) => p.phase)).toEqual(['saveFlushed', 'contentApplied']);

    clearNoteSwitchTimelines();
    expect(getNoteSwitchTimelines()).toHaveLength(0);
  });
});
