import { describe, expect, it } from 'vitest';

import {
  analyzeFrame,
  captureDestination,
  isSuspectFrame,
  parseArgs,
  parseWindowRecords,
  selectWindows,
} from './qa-shot.mjs';

// qa-shot exists so a QA session can screenshot its window WITHOUT activating
// it: several sessions share one Mac with one display, and the documented
// focus-raise (a second copy of the debug binary, so single-instance calls
// window.set_focus()) yanks the human between spaces mid-sentence. These tests
// pin the two properties that make the capture usable and safe — it finds
// windows that are NOT on the current space, and it never widens past the one
// pid the resolver verified.

// One instance's real CGWindowList inventory (measured 2026-08-20), plus a
// window belonging to a different app. Only the real app window is named — the
// trailing empty field on every other row is load-bearing.
const TSV = [
  '7959\t20455\t0\t800\t600\tFUTO Notes (Dev)', // the real app window
  '7960\t20455\t0\t1512\t33\t', // a WebKit/titlebar strip
  '7964\t20455\t0\t500\t500\t', // the blank white helper surface
  '8136\t61111\t25\t312\t237\t', // AutoFill panel — layer 25, not ours
  '7088\t500\t0\t1512\t913\tSome Other App', // another app entirely
].join('\n');

describe('parseWindowRecords', () => {
  it('reads id/pid/layer/size out of the Swift TSV', () => {
    expect(parseWindowRecords(TSV)).toEqual([
      { id: 7959, pid: 20455, layer: 0, width: 800, height: 600, name: 'FUTO Notes (Dev)' },
      { id: 7960, pid: 20455, layer: 0, width: 1512, height: 33, name: '' },
      { id: 7964, pid: 20455, layer: 0, width: 500, height: 500, name: '' },
      { id: 8136, pid: 61111, layer: 25, width: 312, height: 237, name: '' },
      { id: 7088, pid: 500, layer: 0, width: 1512, height: 913, name: 'Some Other App' },
    ]);
  });

  it('drops blank lines, headers and malformed rows instead of yielding NaN windows', () => {
    const records = parseWindowRecords(
      '\nnot a row\n1\t2\t3\nx\ty\tz\tw\tv\tu\n7959\t20455\t0\t800\t600\tName\n',
    );
    expect(records).toEqual([
      { id: 7959, pid: 20455, layer: 0, width: 800, height: 600, name: 'Name' },
    ]);
  });

  it('keeps the empty name of an unnamed window rather than dropping the row', () => {
    // The record ends in a tab. Trimming the whole line would swallow it, drop
    // the row to 5 fields, and silently discard every helper surface — which
    // would look like it worked, since helpers are what we exclude anyway.
    expect(parseWindowRecords('7964\t20455\t0\t500\t500\t')).toEqual([
      { id: 7964, pid: 20455, layer: 0, width: 500, height: 500, name: '' },
    ]);
  });

  it('survives a window title containing a tab', () => {
    // The Swift side strips tabs, but if one ever arrives the numeric fields
    // must still parse — the name is last precisely so it cannot shift them.
    expect(parseWindowRecords('1\t2\t0\t800\t600\ta\tb')).toEqual([
      { id: 1, pid: 2, layer: 0, width: 800, height: 600, name: 'a\tb' },
    ]);
  });
});

describe('selectWindows', () => {
  const records = parseWindowRecords(TSV);

  it('picks the named window and discards the unnamed helper entirely', () => {
    // Only the real window carries a title, so naming is a stronger signal than
    // size: the 500x500 helper clears MIN_WINDOW_EDGE and would otherwise be a
    // candidate, and a capture of it is a plausible-looking blank PNG.
    expect(selectWindows(records, 20455).map((window) => window.id)).toEqual([7959]);
  });

  it('prefers a named window even when an unnamed one is larger', () => {
    const records = parseWindowRecords(
      ['10\t99\t0\t800\t600\tFUTO Notes (Dev)', '11\t99\t0\t1400\t900\t'].join('\n'),
    );
    expect(selectWindows(records, 99).map((window) => window.id)).toEqual([10]);
  });

  it('falls back to largest-area when nothing is named', () => {
    // kCGWindowName is empty for every window without Screen Recording
    // permission. The tool must still choose the real window, not give up.
    const records = parseWindowRecords(
      ['10\t99\t0\t500\t500\t', '11\t99\t0\t800\t600\t'].join('\n'),
    );
    expect(selectWindows(records, 99).map((window) => window.id)).toEqual([11, 10]);
  });

  it('never returns another process’s window, whatever its size', () => {
    // The 1512x913 window is the biggest on the machine; asking for pid 20455
    // must not surface it. Widening past the verified pid is exactly the
    // "a name is not an identity" mistake this tool refuses to repeat.
    expect(selectWindows(records, 20455).every((window) => window.pid === 20455)).toBe(true);
  });

  it('orders by area so the main window comes first', () => {
    const several = parseWindowRecords(
      ['10\t99\t0\t640\t480\t', '11\t99\t0\t1400\t900\t', '12\t99\t0\t900\t700\t'].join('\n'),
    );
    expect(selectWindows(several, 99).map((window) => window.id)).toEqual([11, 12, 10]);
  });

  it('returns nothing for a pid that owns no window yet', () => {
    expect(selectWindows(records, 4242)).toEqual([]);
  });
});

describe('captureDestination', () => {
  const window = { id: 7959, pid: 20455, width: 800, height: 600 };

  it('uses --out verbatim', () => {
    expect(captureDestination(window, { out: 'shots/main.png', defaultDir: '/d' })).toBe(
      'shots/main.png',
    );
  });

  it('falls back to test-screenshots/ with pid and window id in the name', () => {
    // pid + window id keeps parallel worktrees, which all run a binary of the
    // same name, from overwriting each other's captures.
    expect(captureDestination(window, { defaultDir: '/repo/test-screenshots' })).toBe(
      '/repo/test-screenshots/qa-20455-7959.png',
    );
  });
});

describe('parseArgs', () => {
  it('reads a command, its argument and both --out spellings', () => {
    expect(parseArgs(['pid', '20455', '--out', 'a.png'])).toEqual({
      command: 'pid',
      argument: '20455',
      out: 'a.png',
    });
    expect(parseArgs(['port', '9223', '--out=b.png'])).toEqual({
      command: 'port',
      argument: '9223',
      out: 'b.png',
    });
  });

  it('defaults to no --out', () => {
    expect(parseArgs(['list'])).toEqual({ command: 'list', argument: undefined, out: null });
  });
});

// Build an RGBA buffer the way pngjs exposes one.
function frame(width, height, pixelAt) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('analyzeFrame / isSuspectFrame', () => {
  it('flags the exact frame a capture must never be believed for', () => {
    // A flat #1E1E1E window: screencapture exits 0 and writes a normal-sized
    // PNG, so nothing downstream can tell this from "the app rendered nothing"
    // unless the content itself is checked.
    const flat = analyzeFrame(frame(40, 30, () => [0x1e, 0x1e, 0x1e]));
    expect(flat).toEqual({ distinct: 1, dominant: '#1e1e1e', dominantShare: 1 });
    expect(isSuspectFrame(flat)).toBe(true);
  });

  it('flags a flat frame in either theme', () => {
    for (const rgb of [
      [0x0a, 0x0a, 0x0a],
      [0xfc, 0xfc, 0xfc],
    ]) {
      expect(isSuspectFrame(analyzeFrame(frame(20, 20, () => rgb)))).toBe(true);
    }
  });

  it('accepts a sparse but real UI — a big flat background plus a little content', () => {
    // Worst measured real capture: one colour covered 66% of the window. This
    // fixture is harsher still (~94% background) and must NOT trip the guard,
    // because a false alarm on a good screenshot would make the tool useless.
    const sparse = analyzeFrame(
      frame(100, 100, (x, y) => (y < 6 ? [x * 2, y * 3, 100 + x] : [0x0a, 0x0a, 0x0a])),
    );
    expect(sparse.dominantShare).toBeGreaterThan(0.9);
    expect(isSuspectFrame(sparse)).toBe(false);
  });

  it('reports the dominant colour and its share', () => {
    const half = analyzeFrame(frame(10, 10, (x) => (x < 5 ? [1, 2, 3] : [4, 5, 6])));
    expect(half.distinct).toBe(2);
    expect(half.dominantShare).toBe(0.5);
  });

  it('treats a two-colour frame as suspect even when neither dominates', () => {
    // Nothing real is two colours; this is the checkerboard/placeholder case.
    const twoTone = analyzeFrame(frame(10, 10, (x) => (x < 5 ? [1, 2, 3] : [4, 5, 6])));
    expect(isSuspectFrame(twoTone)).toBe(true);
  });
});
