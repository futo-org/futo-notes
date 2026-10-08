// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginInteraction,
  clearInteractions,
  endInteraction,
  getInteractions,
  isKeystrokeTripwireEnabled,
  keystrokeFrameSamplesMs,
  markInteraction,
  noteKeystroke,
  setKeystrokeTripwire,
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
  setKeystrokeTripwire(false);
  vi.unstubAllGlobals();
});

describe('interaction ledger', () => {
  it('records phases relative to the interaction start, per kind', () => {
    beginInteraction('note-open', 'note-a');
    markInteraction('note-open', 'interactive');
    markInteraction('note-open', 'complete');
    endInteraction('note-open');

    const [record] = getInteractions('note-open');
    expect(record.kind).toBe('note-open');
    expect(record.subject).toBe('note-a');
    expect(record.phases.map((p) => p.phase)).toEqual(['interactive', 'complete']);
    expect(record.phases[0].atMs).toBeGreaterThanOrEqual(0);
    expect(record.phases[1].atMs).toBeGreaterThanOrEqual(record.phases[0].atMs);
  });

  it('keeps kinds independent: a mark for one kind never lands on another', () => {
    beginInteraction('note-switch', 'a');
    beginInteraction('block-drag', 'b');
    markInteraction('block-drag', 'lift');
    markInteraction('note-switch', 'noteRead');

    expect(getInteractions('note-switch')[0].phases.map((p) => p.phase)).toEqual(['noteRead']);
    expect(getInteractions('block-drag')[0].phases.map((p) => p.phase)).toEqual(['lift']);
    expect(getInteractions()).toHaveLength(2);
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

  it('is bounded per kind: only the most recent records of a kind are retained', () => {
    for (let i = 0; i < 250; i += 1) beginInteraction('note-open', String(i));
    const records = getInteractions('note-open');
    expect(records).toHaveLength(100);
    expect(records[0].subject).toBe('150');
  });

  it("a burst of one kind never evicts another kind's records", () => {
    beginNoteSwitch('kept');
    endNoteSwitch();
    for (let i = 0; i < 250; i += 1) beginInteraction('block-drag');
    expect(getNoteSwitchTimelines().map((t) => t.noteId)).toEqual(['kept']);
  });

  it('reads every kind in start order when no kind is given', () => {
    beginInteraction('note-open', 'first');
    beginInteraction('note-switch', 'second');
    beginInteraction('note-open', 'third');
    expect(getInteractions().map((r) => r.subject)).toEqual(['first', 'second', 'third']);
  });

  it('clears one kind without touching the others', () => {
    beginInteraction('note-open');
    beginInteraction('keystroke');
    clearInteractions('keystroke');
    expect(getInteractions('keystroke')).toHaveLength(0);
    expect(getInteractions('note-open')).toHaveLength(1);
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

describe('keystroke tripwire', () => {
  it('is off by default: an edit records nothing and asks for no frame', () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    expect(isKeystrokeTripwireEnabled()).toBe(false);
    noteKeystroke();
    expect(raf).not.toHaveBeenCalled();
    expect(getInteractions('keystroke')).toHaveLength(0);
  });

  it('enabled, samples ONE record per frame: the first edit in the frame, closed by one frame callback', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => callbacks.push(cb));
    setKeystrokeTripwire(true);

    noteKeystroke();
    noteKeystroke();
    noteKeystroke();
    expect(callbacks).toHaveLength(1);
    expect(getInteractions('keystroke')).toHaveLength(1);
    expect(keystrokeFrameSamplesMs()).toEqual([]);

    callbacks[0](performance.now());
    expect(keystrokeFrameSamplesMs()).toHaveLength(1);
    expect(keystrokeFrameSamplesMs()[0]).toBeGreaterThanOrEqual(0);

    // The next frame's first edit opens the next sample.
    noteKeystroke();
    expect(callbacks).toHaveLength(2);
    callbacks[1](performance.now());
    expect(keystrokeFrameSamplesMs()).toHaveLength(2);
  });

  it('turned off again, stops recording', () => {
    const raf = vi.fn((cb: FrameRequestCallback) => cb(performance.now()));
    vi.stubGlobal('requestAnimationFrame', raf);
    setKeystrokeTripwire(true);
    noteKeystroke();
    setKeystrokeTripwire(false);
    noteKeystroke();
    expect(raf).toHaveBeenCalledTimes(1);
    expect(keystrokeFrameSamplesMs()).toHaveLength(1);
  });
});
