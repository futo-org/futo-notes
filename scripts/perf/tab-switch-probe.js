// Tab-switch latency probe for the desktop app.
//
// Paste the whole file into the running dev app's webview (the MCP bridge's
// webview_execute_js, or the Web Inspector console) and call:
//
//   await __tabSwitchProbe.setup(6)      // open N tabs spanning the note sizes
//   await __tabSwitchProbe.measure(7)    // returns per-switch phase timings
//   __tabSwitchProbe.summarize(rows)     // p50/p90 per phase
//
// Baseline and interpretation: docs/perf/tab-switch-baseline.md
//
// It drives Ctrl+Tab through the real window keydown listener
// (registerNotesShellShortcuts), so it exercises the shipping shortcut path.
// Phase timings come from the always-on timeline in
// src/shared/perf/noteSwitchTimeline.ts, surfaced via __notesShellTest.

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const hook = () => window.__notesShellTest;

  function ctrlTab() {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }

  // One Ctrl+Tab, measured from the keypress to the frame that shows the new
  // note. `paint` is the perceived number; the phase fields attribute it.
  async function one() {
    const prevDoc = hook().getState().editorContent;
    const frames = [];
    const t0 = performance.now();
    ctrlTab();
    for (let i = 0; i < 120; i += 1) {
      await raf();
      frames.push(Math.round(performance.now() - t0));
      if (hook().getState().editorContent !== prevDoc) break;
    }
    await raf(); // the frame that paints the new content
    const paint = Math.round(performance.now() - t0);
    const timeline = hook().noteSwitchTimelines().slice(-1)[0];
    const phases = Object.fromEntries(timeline.phases.map((p) => [p.phase, Math.round(p.atMs)]));
    return {
      note: timeline.noteId,
      bytes: hook().getState().editorContent.length,
      // keydown -> the Svelte effect entering createTabNoteTransition
      effectLatency: Math.round(timeline.startedAt - t0),
      ...phases,
      paint,
      frames,
    };
  }

  window.__tabSwitchProbe = {
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
    async measure(rounds = 7, warmup = 7) {
      for (let i = 0; i < warmup; i += 1) {
        await one();
        await sleep(150);
      }
      const rows = [];
      for (let i = 0; i < rounds; i += 1) {
        rows.push(await one());
        await sleep(150);
      }
      return rows;
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
