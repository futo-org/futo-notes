// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installPerfCourse } from './installPerfCourse';
import {
  beginPerfSpan,
  countPerfEvents,
  drainPerfEvents,
  recordPerfEvent,
  startFrameProbe,
  stopFrameProbe,
} from './perfEvents';

// The collector is intentionally module-level singleton state, so every test
// starts from a drained buffer and a stopped probe.
afterEach(() => {
  stopFrameProbe();
  drainPerfEvents();
  vi.unstubAllGlobals();
});

describe('recordPerfEvent', () => {
  it('records name, duration, detail, and a start derived from the duration', () => {
    const beforeMs = performance.now();
    recordPerfEvent('note-open', 25, 'note-a');
    const afterMs = performance.now();

    const events = drainPerfEvents();
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('note-open');
    expect(events[0].durationMs).toBe(25);
    expect(events[0].detail).toBe('note-a');
    expect(events[0].startMs).toBeGreaterThanOrEqual(beforeMs - 25);
    expect(events[0].startMs).toBeLessThanOrEqual(afterMs - 25);
  });

  it('omits detail when none is given', () => {
    recordPerfEvent('startup:notes-loaded', 120);
    expect(drainPerfEvents()[0]).not.toHaveProperty('detail');
  });

  it('drops the oldest events beyond the 500-event cap', () => {
    for (let i = 0; i < 520; i += 1) recordPerfEvent(`event-${i}`, 1);
    expect(countPerfEvents()).toBe(500);

    const events = drainPerfEvents();
    expect(events[0].name).toBe('event-20');
    expect(events[499].name).toBe('event-519');
  });
});

describe('drainPerfEvents', () => {
  it('returns buffered events and clears the buffer', () => {
    recordPerfEvent('a', 1);
    recordPerfEvent('b', 2);

    expect(drainPerfEvents().map((event) => event.name)).toEqual(['a', 'b']);
    expect(countPerfEvents()).toBe(0);
    expect(drainPerfEvents()).toEqual([]);
  });
});

describe('beginPerfSpan', () => {
  it('records one event on end, combining detail and extra detail', () => {
    const end = beginPerfSpan('search:query', 'groceries');
    end('→ 3 results');

    const events = drainPerfEvents();
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('search:query');
    expect(events[0].detail).toBe('groceries → 3 results');
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ignores a second end call', () => {
    const end = beginPerfSpan('note-open', 'note-a');
    end();
    end('again');

    expect(drainPerfEvents()).toHaveLength(1);
  });

  it('records nothing while the span is unended', () => {
    beginPerfSpan('note-open', 'superseded');
    expect(countPerfEvents()).toBe(0);
  });
});

describe('frame probe', () => {
  function stubAnimationFrames() {
    let pending: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      pending = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', (): void => {
      pending = null;
    });
    return (frameTimeMs: number) => {
      const callback = pending;
      pending = null;
      callback?.(frameTimeMs);
    };
  }

  it('counts frames and records inter-frame deltas', () => {
    const fireFrame = stubAnimationFrames();
    startFrameProbe();
    fireFrame(100);
    fireFrame(110);
    fireFrame(126);

    expect(stopFrameProbe()).toEqual({ frames: 3, deltasMs: [10, 16] });
  });

  it('returns empty when stopped while not running', () => {
    expect(stopFrameProbe()).toEqual({ frames: 0, deltasMs: [] });
  });

  it('restarts when started while already running', () => {
    const fireFrame = stubAnimationFrames();
    startFrameProbe();
    fireFrame(100);
    fireFrame(150);

    startFrameProbe();
    fireFrame(200);
    fireFrame(210);

    expect(stopFrameProbe()).toEqual({ frames: 2, deltasMs: [10] });
  });
});

describe('installPerfCourse', () => {
  it('exposes drain, count, and the frame probe on the target', () => {
    const target = {} as Window;
    installPerfCourse(target);

    recordPerfEvent('note-open', 5, 'note-a');
    expect(target.__perfCourse?.count()).toBe(1);
    expect(target.__perfCourse?.drain().map((event) => event.name)).toEqual(['note-open']);
    expect(target.__perfCourse?.count()).toBe(0);
    expect(typeof target.__perfCourse?.startFrameProbe).toBe('function');
    expect(typeof target.__perfCourse?.stopFrameProbe).toBe('function');
  });
});
