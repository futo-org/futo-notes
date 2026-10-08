// Tab-switch latency probe for the desktop app.
//
// Paste the whole file into the running dev app's webview (the MCP bridge's
// webview_execute_js, or the Web Inspector console) and call:
//
//   await __tabSwitchProbe.check()       // RUN FIRST: hooks present? frames live?
//   await __tabSwitchProbe.setup(6)      // open N tabs spanning the note sizes
//   await __tabSwitchProbe.measure(7)    // returns per-switch phase timings
//   __tabSwitchProbe.summarize(rows)     // p50/p90 per phase
//
// Baseline and interpretation: docs/perf/tab-switch-baseline.md
//
// If check() reports framesLive:false the window is occluded or minimised —
// WebKit suspends requestAnimationFrame for a window it is not compositing, so
// every measurement here would block. Bring the app forward first; the
// sanctioned way to do that is in .claude/skills/verify/references/desktop.md.
//
// It drives Ctrl+Tab through the real window keydown listener
// (registerNotesShellShortcuts), so it exercises the shipping shortcut path.
// Phase timings come from the always-on timeline in
// src/shared/perf/noteSwitchTimeline.ts, surfaced via __notesShellTest.

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A macrotask turn without setTimeout's nesting clamp: lets the switch's own
  // tasks (IPC callbacks, the read, the replace) run between polls. ONE
  // channel for the whole probe: a port with a listener is never collected,
  // and a channel per tick grew the web process past WebKit's 16 GB kill
  // threshold within a couple of hundred switches.
  const tickChannel = new MessageChannel();
  const tickWaiters = [];
  tickChannel.port1.onmessage = () => tickWaiters.shift()?.();
  const tick = () =>
    new Promise((r) => {
      tickWaiters.push(r);
      tickChannel.port2.postMessage(null);
    });
  const hook = () => window.__notesShellTest;

  // WebKit suspends requestAnimationFrame for an occluded/minimised window, so
  // a bare `await raf()` never resolves and the probe hangs FOREVER with no
  // output — it looks stuck rather than blocked, and a QA leg reported the perf
  // claim BLOCKED because of it (pc_00c64855edc9). Every await here is bounded:
  // a stalled frame clock throws a named error instead of hanging.
  const FRAME_STALL_MS = 1200;

  class FramesStalledError extends Error {
    constructor() {
      super(
        'frames are stalled: requestAnimationFrame delivered no frame in ' +
          FRAME_STALL_MS +
          'ms. The window is almost certainly occluded or minimised — WebKit ' +
          'suspends rAF for a window it is not compositing. Bring the app ' +
          'forward and re-run; see .claude/skills/verify/references/desktop.md ' +
          'for the sanctioned way to focus a dev window.',
      );
      this.name = 'FramesStalledError';
    }
  }

  const raf = () =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new FramesStalledError());
      }, FRAME_STALL_MS);
      requestAnimationFrame(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });

  // Is the frame clock actually running? Resolves true/false in <= FRAME_STALL_MS
  // instead of hanging, so a caller can tell "app is broken" from "window is
  // not being composited" before spending a measurement run on it.
  async function framesLive() {
    try {
      await raf();
      return true;
    } catch (err) {
      if (err instanceof FramesStalledError) return false;
      throw err;
    }
  }

  function ctrlTab() {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }

  const OPEN_COMPLETE = 'futo:editor-open-complete';

  // The editor clears its open measures when a load starts and records
  // `futo:editor-open-complete` once the last chunk is in (progressiveLoad.ts),
  // so this is "the incoming note has fully landed" — a 10k-line note streams
  // its tail in idle slices after the switch painted. Bounded: a note that
  // never records one (a failed load) must not hang the run.
  async function settled(since, maxMs = 6000) {
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
      // Only a measure whose open STARTED after `since`: the previous note's
      // entry is still in the buffer until the next load clears it.
      const entry = performance
        .getEntriesByName(OPEN_COMPLETE)
        .find((candidate) => candidate.startTime >= since);
      if (entry) return Math.round(entry.duration);
      await sleep(20);
    }
    return null;
  }

  // One Ctrl+Tab, measured from the keypress to the frame that shows the new
  // note. `paint` is the perceived number; the phase fields attribute it.
  // `dirty` types one character into the outgoing note first, in the same
  // task as the keypress, so the switch pays a real save (the flush a clean
  // switch skips) — the shape of "type, then Ctrl+Tab immediately".
  //
  // `frameless` measures a window whose frame clock is stalled (occluded, or
  // a compositor that refused to raise it): instead of waiting for the frame
  // that paints, it polls on message-channel ticks until the editor holds the
  // new note and then forces style + layout of the editor, reporting that as
  // `layout`. It excludes paint and compositing, so it is a lower bound on
  // `paint`, not a substitute for it — record which mode a run used.
  async function one({ dirty = false, frameless = false } = {}) {
    const from = hook().getState().originalId;
    const frames = [];
    if (dirty) hook().typeInEditor('x');
    // Read AFTER the edit: the switch is what changes the content from here.
    const prevDoc = hook().getState().editorContent;
    const t0 = performance.now();
    ctrlTab();
    let paint = null;
    let layout = null;
    if (frameless) {
      const deadline = t0 + 5000;
      while (hook().getState().editorContent === prevDoc && performance.now() < deadline) {
        await tick();
      }
      document.querySelector('.ProseMirror')?.getBoundingClientRect();
      layout = Math.round(performance.now() - t0);
    } else {
      for (let i = 0; i < 120; i += 1) {
        await raf();
        frames.push(Math.round(performance.now() - t0));
        if (hook().getState().editorContent !== prevDoc) break;
      }
      await raf(); // the frame that paints the new content
      paint = Math.round(performance.now() - t0);
    }
    const timeline = hook().noteSwitchTimelines().slice(-1)[0];
    const phases = Object.fromEntries(timeline.phases.map((p) => [p.phase, Math.round(p.atMs)]));
    // Let the tail land before the next switch, and report the editor's own
    // open span (parse + apply, first chunk to last) for the incoming note.
    const openComplete = await settled(t0);
    return {
      from,
      note: timeline.noteId,
      dirty,
      bytes: hook().getState().editorContent.length,
      openComplete,
      // keydown -> the Svelte effect entering createTabNoteTransition
      effectLatency: Math.round(timeline.startedAt - t0),
      ...phases,
      paint,
      layout,
      frames,
    };
  }

  window.__tabSwitchProbe = {
    // Run this FIRST. Reports whether the probe can actually measure anything:
    // the test hooks it needs, and whether frames are being delivered at all.
    // Returns in ~1.2s worst case rather than hanging (pc_00c64855edc9).
    async check() {
      const missing = ['__notesShellTest', '__testNotes'].filter((k) => !window[k]);
      const live = await framesLive();
      return {
        ok: missing.length === 0 && live,
        framesLive: live,
        missingHooks: missing,
        note: live
          ? missing.length
            ? 'missing test hooks — is this a debug build?'
            : 'ready'
          : 'frames are stalled (window occluded/minimised) — measurements would hang',
      };
    },

    framesLive,

    // Opens `count` tabs on notes spanning the vault's size distribution.
    async setup(count = 6) {
      const notes = window.__testNotes
        .getAllNotes()
        .map((n) => n.id)
        .filter(Boolean);
      const step = Math.max(1, Math.floor(notes.length / count));
      const picked = Array.from({ length: count }, (_, i) => notes[i * step]).filter(Boolean);
      for (const id of picked) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 't',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await sleep(120);
        window.location.hash = '#/note/' + encodeURIComponent(id);
        await sleep(400);
      }
      return document.querySelectorAll('.tab-pill').length;
    },

    // `warmup` full cycles are discarded before `rounds` measured switches.
    // `dirty` makes every measured switch leave a note with an unsaved edit;
    // `frameless` is the stalled-frame-clock mode described at `one`.
    async measure(rounds = 7, warmup = 7, { dirty = false, frameless = false } = {}) {
      for (let i = 0; i < warmup; i += 1) {
        await one({ dirty, frameless });
        await sleep(150);
      }
      const rows = [];
      for (let i = 0; i < rounds; i += 1) {
        rows.push(await one({ dirty, frameless }));
        await sleep(150);
      }
      return rows;
    },

    // Closes every tab but one, then opens one tab per note id, in order
    // (Ctrl+T, then the note's route). The survivor is the first id's tab.
    async openTabs(ids) {
      for (
        let guard = 0;
        guard < 64 && document.querySelectorAll('.tab-pill').length > 1;
        guard += 1
      ) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'w',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await sleep(80);
      }
      let first = true;
      for (const id of ids) {
        if (!first) {
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 't',
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
          await sleep(120);
        }
        first = false;
        const t0 = performance.now();
        window.location.hash = '#/note/' + encodeURIComponent(id);
        await sleep(300);
        await settled(t0);
      }
      return document.querySelectorAll('.tab-pill').length;
    },

    summarize(rows) {
      const q = (key, p) => {
        const s = rows
          .map((r) => r[key])
          .filter((v) => v != null)
          .sort((a, b) => a - b);
        return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
      };
      const keys = [
        'effectLatency',
        'saveFlushed',
        'readStarted',
        'noteRead',
        'contentApplied',
        'paint',
        'layout',
        'openComplete',
      ];
      return Object.fromEntries(keys.map((k) => [k, { p50: q(k, 0.5), p90: q(k, 0.9) }]));
    },

    // Cost attribution: re-measure with only the first `keep` sidebar rows
    // rendered. Pass null to restore. `display:none` is the point — `contain`
    // and `content-visibility` do NOT reproduce the effect.
    async withSidebarRows(keep) {
      document.getElementById('__perfProbe')?.remove();
      if (keep !== null) {
        const style = document.createElement('style');
        style.id = '__perfProbe';
        style.textContent = `.folder-tree-scroll > *:nth-child(n+${keep + 1}) { display: none !important; }`;
        document.head.appendChild(style);
      }
      await sleep(350);
    },
  };

  return 'probe installed: __tabSwitchProbe';
})();
