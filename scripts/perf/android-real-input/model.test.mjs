import { describe, expect, it } from 'vitest';
import {
  encodePlan,
  failures,
  frameSummary,
  latencyWindows,
  navigationTrials,
  typingPlan,
} from './model.mjs';

describe('real Android input acceptance', () => {
  it('keeps paragraph typing on one paragraph and includes a thinking pause', () => {
    const plan = typingPlan('paragraph');
    expect(plan.length).toBeGreaterThan(100);
    expect(plan.filter((e) => e.y === 1454 && e.x === 665)).toHaveLength(0);
    expect(plan[60].time - plan[59].time).toBeGreaterThan(1800);
    expect(encodePlan(plan)).toBe(encodePlan(typingPlan('paragraph')));
  });

  it('includes Enter and deletion in ordinary editing', () => {
    const plan = typingPlan('meeting');
    expect(plan.some((e) => e.x === 665 && e.y === 1454)).toBe(true);
    expect(plan.some((e) => e.x === 665 && e.y === 1348)).toBe(true);
  });

  it('requires latency coverage through the final touch, including a partial tail', () => {
    const windows = latencyWindows(
      'input→draw over 50: p50=15ms p95=20ms max=25ms workP95=8ms resumeMax=25ms firstInputNs=100 lastInputNs=800 ' +
        'input→draw over 50: p50=15ms p95=20ms max=25ms workP95=8ms resumeMax=0ms firstInputNs=900 lastInputNs=1800 ' +
        'input→draw over 37: p50=15ms p95=20ms max=25ms workP95=8ms resumeMax=0ms firstInputNs=1900 lastInputNs=3000',
    );
    const story = {
      name: 'complete',
      events: 150,
      frames: Array(150).fill({ jank: 'None' }),
      windows,
      inputEvents: [
        { downNs: 90, upNs: 110 },
        { downNs: 2900, upNs: 3010 },
      ],
    };
    expect(failures({ typing: [story] })).toEqual([]);
    expect(failures({ typing: [{ ...story, windows: windows.slice(0, 2) }] })).toContain(
      'complete: incomplete native latency coverage',
    );
  });

  it('distinguishes delayed input from an on-time rendered frame', () => {
    const windows = latencyWindows(
      'input→draw over 50: p50=29.1ms p95=37.3ms max=96ms workP95=21ms resumeMax=96ms',
    );
    const result = failures({
      typing: [
        {
          name: 'paragraph',
          events: 126,
          windows: [...windows, ...windows],
          frames: Array.from({ length: 158 }, () => ({ jank: 'None' })),
        },
      ],
    });
    expect(result).toEqual([]);
    expect(windows[0]).toMatchObject({ p95: 37.3, workP95: 21, resumeMax: 96 });
  });

  it('reports dropped frames even when no app-deadline flag was attached', () => {
    const story = {
      name: 'dropped',
      events: 150,
      windows: Array(3).fill({ count: 50, p95: 20, workP95: 8, resumeMax: 25 }),
      frames: Array(150).fill({ jank: 'None', presentType: 'On-time Present' }),
    };
    story.frames[77] = { jank: 'None', presentType: 'Dropped Frame' };
    expect(frameSummary(story.frames)).toEqual({
      frames: 150,
      appDeadlineMisses: 0,
      droppedFrames: 1,
    });
  });

  it('fails missing samples and missing diagnostics, rather than silently passing', () => {
    expect(failures({}).length).toBeGreaterThan(0);
    expect(
      failures({ typing: [{ name: 'empty', events: 126, windows: [], frames: [] }] }),
    ).toContain('empty: incomplete typing evidence');
    expect(latencyWindows('input→draw over 50: p50=15ms p95=22ms max=60ms')[0].workP95).toBeNull();
  });

  it('measures presentation, counts app misses, and refuses an empty transition', () => {
    const event = { label: 'open-meeting', downNs: 1e9, upNs: 1.035e9 };
    const trials = navigationTrials(
      [{ ts: 1.1e9, presentNs: 1.4e9, jank: 'App Deadline Missed' }],
      [event],
    );
    expect(trials[0]).toMatchObject({ missed: 1, settledMs: 400 });
    expect(failures({ navigation: Array(6).fill({ ...trials[0], frames: 15 }) })).toEqual([]);
    expect(() => navigationTrials([], [event])).toThrow('No presented app frames');
  });
});
