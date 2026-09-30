// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform/tauri', () => ({ reportUnsavedEdits: vi.fn(async () => undefined) }));

import { noteEditIntent } from '$shared/lifecycle/editIntent';
import { startCloseDirtyReporter } from './closeDeadlineDirty';

describe('close-deadline dirty reporter', () => {
  let pending: boolean;
  let reports: boolean[];
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    pending = false;
    reports = [];
    stop = startCloseDirtyReporter({
      isSavePending: () => pending,
      report: (dirty) => reports.push(dirty),
      now: () => Date.now(),
    });
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('says nothing while the page is clean', () => {
    vi.advanceTimersByTime(5000);
    expect(reports).toEqual([]);
  });

  it('reports dirty on a pending save and clean when it lands, once each', () => {
    pending = true;
    vi.advanceTimersByTime(400);
    expect(reports).toEqual([true]);
    pending = false;
    vi.advanceTimersByTime(400);
    expect(reports).toEqual([true, false]);
  });

  it.each(['beforeinput', 'paste', 'cut', 'drop'])(
    'reports dirty at once on %s, before any save is pending, then settles',
    (type) => {
      document.dispatchEvent(new Event(type));
      expect(reports).toEqual([true]);
      vi.advanceTimersByTime(1000);
      expect(reports).toEqual([true, false]);
    },
  );

  it('does not treat a click or a keydown as an edit', () => {
    document.dispatchEvent(new Event('pointerdown'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(reports).toEqual([]);
  });

  it('keeps the dirty report in force while the thread cannot run a poll', () => {
    // A paste that blocks the JS thread: the event reported, and no timer runs until it ends.
    document.dispatchEvent(new Event('paste'));
    expect(reports).toEqual([true]);
    // (no timers advance: the thread is blocked) — nothing un-reports it.
    expect(reports.at(-1)).toBe(true);
  });

  it('noteEditIntent announces an edit that has no input event', () => {
    noteEditIntent();
    expect(reports).toEqual([true]);
  });

  it('stays dirty across back-to-back edits and while a save is pending', () => {
    document.dispatchEvent(new Event('beforeinput'));
    vi.advanceTimersByTime(300);
    document.dispatchEvent(new Event('beforeinput'));
    pending = true;
    vi.advanceTimersByTime(2000);
    expect(reports).toEqual([true]);
    pending = false;
    vi.advanceTimersByTime(400);
    expect(reports).toEqual([true, false]);
  });
});
