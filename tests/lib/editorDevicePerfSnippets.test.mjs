import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import {
  connectPage,
  keystrokeExpression,
  measureExpression,
  saveExpression,
  summarizeProfile,
} from './editorDevicePerfSnippets.mjs';

describe('open then type', () => {
  it('lets the browser present the opened document before the first keystroke', async () => {
    const calls = [];
    let focused = false;
    const view = {
      focus: () => {
        calls.push('focus');
        focused = true;
      },
      hasFocus: () => focused,
      dom: {
        blur: () => {
          calls.push('blur');
          focused = false;
        },
      },
      state: { doc: { content: { size: 1000 } }, tr: { insertText: () => ({}) } },
      dispatch: () => calls.push('dispatch'),
    };
    let clock = 0;
    const context = {
      window: {
        FutoEditor: {
          setContent: (_id, md) => calls.push(md === '' ? 'reset' : 'setContent'),
        },
        __futoTest: {
          readDocument: () => '',
          documentRef: () => ({ noteId: 'perf-note', generation: 1 }),
        },
        __futoProseMirrorView: () => view,
      },
      performance: { now: () => ++clock, getEntriesByName: () => [{ duration: 7 }] },
      requestAnimationFrame: (callback) => {
        calls.push('frame');
        callback();
      },
      setTimeout: (callback) => callback(),
    };
    const result = await runInNewContext(measureExpression('# note', 2), context);
    // Every fixture starts from an emptied editor, and a whole-document open
    // marks itself complete in the task that inserted the DOM: at least two
    // frames must pass (the second only after a layout) before anything is
    // timed, or the document's first layout is billed to what follows. The fake
    // clock makes every frame short, so exactly two are waited here. Then the
    // first focus is timed to its third frame and blurred again, so the
    // keystroke loop measures the gate's unfocused unit.
    expect(calls).toEqual([
      'reset',
      'frame',
      'setContent',
      'frame',
      'frame',
      'focus',
      'frame',
      'frame',
      'frame',
      'blur',
      'frame',
      'dispatch',
      'frame',
      'dispatch',
      'frame',
    ]);
    expect(result.completeMs).toBe(7);
    expect(result.firstFocusMs).toBeGreaterThan(0);
    expect(result.synchronousSamplesMs).toHaveLength(2);
  });
});

describe('typing measurement modes', () => {
  function setup(takesFocus = true) {
    let focused = false;
    const calls = [];
    const view = {
      focus: () => {
        calls.push('focus');
        focused = takesFocus;
      },
      hasFocus: () => focused,
      state: { tr: { insertText: () => ({}) } },
      dispatch: () => calls.push('dispatch'),
    };
    let clock = 0;
    const context = {
      window: { __futoProseMirrorView: () => view },
      performance: { now: () => ++clock },
      requestAnimationFrame: (callback) => {
        calls.push('frame');
        callback();
      },
    };
    return { calls, run: (options) => runInNewContext(keystrokeExpression(3, options), context) };
  }

  it('preserves the gate baseline and one frame per dispatch by default', async () => {
    const probe = setup();
    const result = await probe.run();
    expect(probe.calls).toEqual(['dispatch', 'frame', 'dispatch', 'frame', 'dispatch', 'frame']);
    expect(result.synchronousSamplesMs).toHaveLength(3);
    expect(result.settledToPaintSamplesMs).toHaveLength(3);
  });

  it('takes real editor focus before a focused burst', async () => {
    const probe = setup();
    await probe.run({ focused: true });
    expect(probe.calls).toEqual([
      'focus',
      'dispatch',
      'frame',
      'dispatch',
      'frame',
      'dispatch',
      'frame',
    ]);
  });

  it('fails instead of measuring an unfocused editor as focused', async () => {
    const probe = setup(false);
    await expect(probe.run({ focused: true })).rejects.toThrow('did not take focus');
    expect(probe.calls).toEqual(['focus']);
  });
});

describe('save measurement', () => {
  /**
   * A fake editor: an edit bumps the document generation and queues the
   * debounced `change` report, which the editor posts through whatever
   * `window.futoBridge` is at that moment (as postToHost does), delivered while
   * the measurement waits.
   */
  function setup({ reports = true, readGrows = true, keepsIdentity = false, step = 1 } = {}) {
    const calls = [];
    const type = { create: (attrs, content, marks) => ({ type, attrs, content, marks }) };
    let blocks = [type.create({}, null, []), type.create({}, null, [])];
    let generation = 1;
    let text = 'note';
    const queued = [];
    const view = {
      get state() {
        const doc = {
          forEach: (f) => blocks.forEach(f),
          content: { size: 8 },
          firstChild: blocks[0],
        };
        const tr = {
          meta: {},
          insertText: () => Object.assign(tr, { kind: 'edit' }),
          replaceWith: (_from, _to, fresh) => Object.assign(tr, { kind: 'fresh', fresh }),
          setMeta: (key, value) => Object.assign(tr, { meta: { ...tr.meta, [key]: value } }),
        };
        return { doc, tr };
      },
      dispatch(tr) {
        if (tr.kind === 'fresh') {
          calls.push(`fresh blocks, addToHistory ${tr.meta.addToHistory}`);
          if (!keepsIdentity) blocks = tr.fresh;
          return;
        }
        calls.push('edit');
        generation += 1;
        if (readGrows) text += 'x';
        if (reports) queued.push(generation);
      },
    };
    const host = {
      postMessage: (json) => calls.push(`reported ${JSON.parse(json).generation}`),
    };
    const window = {
      __futoProseMirrorView: () => view,
      __futoTest: {
        documentRef: () => ({ noteId: 'note', generation }),
        readDocument: () => {
          calls.push('read');
          return text;
        },
      },
      futoBridge: host,
    };
    let clock = 0;
    const context = {
      window,
      performance: { now: () => (clock += step) },
      setTimeout: (callback) => {
        for (const queuedGeneration of queued.splice(0)) {
          window.futoBridge.postMessage(
            JSON.stringify({ type: 'change', noteId: 'note', generation: queuedGeneration }),
          );
        }
        callback();
      },
    };
    return {
      calls,
      window,
      host,
      run: (options) => runInNewContext(saveExpression(2, options), context),
    };
  }

  it('times a warm read after each edit, once the editor has reported the document', async () => {
    const probe = setup();
    const result = await probe.run();
    // Its own edit first, so the report it waits for cannot predate the tap.
    expect(probe.calls.slice(0, 2)).toEqual(['edit', 'reported 2']);
    expect(probe.calls.filter((call) => call === 'read')).toHaveLength(3);
    expect(probe.calls.some((call) => call.startsWith('fresh'))).toBe(false);
    expect(result.warmSamplesMs).toHaveLength(2);
    expect(result.coldSamplesMs).toEqual([]);
    expect(probe.window.futoBridge).toBe(probe.host);
  });

  it('gives every block a fresh identity, outside the history, before each cold edit', async () => {
    const probe = setup();
    const result = await probe.run({ cold: true });
    const fresh = probe.calls.filter((call) => call.startsWith('fresh'));
    expect(fresh).toEqual(Array(2).fill('fresh blocks, addToHistory false'));
    expect(result.coldSamplesMs).toHaveLength(2);
    expect(result.warmSamplesMs).toEqual([]);
  });

  it('fails instead of timing a cold read against blocks the cache already holds', async () => {
    const probe = setup({ keepsIdentity: true });
    await expect(probe.run({ cold: true })).rejects.toThrow('kept their identity');
  });

  it('fails when a read does not carry the edit, and still restores the bridge', async () => {
    const probe = setup({ readGrows: false });
    await expect(probe.run()).rejects.toThrow('did not carry the edit');
    expect(probe.window.futoBridge).toBe(probe.host);
  });

  it('fails when the editor never reports the edit', async () => {
    const probe = setup({ reports: false, step: 1_000 });
    await expect(probe.run()).rejects.toThrow('never reported generation 2');
  });
});

class TestSocket extends EventEmitter {
  static latest;
  constructor() {
    super();
    TestSocket.latest = this;
    globalThis.queueMicrotask(() => this.emit('open'));
  }
  send() {}
  terminate() {
    this.emit('close');
  }
}

describe('device CDP session', () => {
  it('rejects a command when a renderer stops answering', async () => {
    vi.useFakeTimers();
    try {
      const page = await connectPage('ws://test', TestSocket);
      const result = expect(page.send('Page.navigate')).rejects.toThrow('Page.navigate');
      await vi.advanceTimersByTimeAsync(30_001);
      await result;
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects pending commands when the connection closes', async () => {
    const page = await connectPage('ws://test', TestSocket);
    const result = expect(page.send('Runtime.evaluate')).rejects.toThrow('closed');
    TestSocket.latest.emit('close');
    await result;
    page.close();
  });
});

/**
 * A V8 profile shaped like `Profiler.stop` returns: root → main → {parse, render}
 * with render → layout. Four samples of 1000µs each: one on parse, one on
 * render, two on layout.
 */
const frame = (functionName, url = 'editor.html', lineNumber = 9) => ({
  functionName,
  url,
  lineNumber,
  columnNumber: 0,
  scriptId: '1',
});
const profile = {
  nodes: [
    { id: 1, callFrame: frame('(root)', ''), children: [2] },
    { id: 2, callFrame: frame('main'), children: [3, 4] },
    { id: 3, callFrame: frame('parse') },
    { id: 4, callFrame: frame('render'), children: [5] },
    { id: 5, callFrame: frame('layout') },
  ],
  samples: [3, 4, 5, 5],
  timeDeltas: [1000, 1000, 1000, 1000],
};

describe('summarizeProfile', () => {
  it('charges self time to the sampled frame', () => {
    const { totalMs, frames } = summarizeProfile(profile);
    expect(totalMs).toBe(4);
    expect(frames[0]).toMatchObject({ label: 'layout editor.html:10', ms: 2, share: 0.5 });
    expect(frames.map((f) => f.label)).not.toContain('main editor.html:10');
  });

  it('charges inclusive time once to every distinct frame on the stack', () => {
    const { inclusive } = summarizeProfile(profile);
    const byLabel = Object.fromEntries(inclusive.map((row) => [row.label, row.ms]));
    expect(byLabel['main editor.html:10']).toBe(4);
    expect(byLabel['render editor.html:10']).toBe(3);
    expect(byLabel['parse editor.html:10']).toBe(1);
  });

  it('names the callers of a function', () => {
    const { callers } = summarizeProfile(profile, { callers: 'layout' });
    expect(callers.needle).toBe('layout');
    expect(callers.rows).toEqual([{ label: 'render editor.html:10', ms: 2, share: 0.5 }]);
  });

  it('groups by script', () => {
    const { urls } = summarizeProfile(profile);
    expect(urls[0]).toMatchObject({ label: 'editor.html', ms: 4 });
  });
});
