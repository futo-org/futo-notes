/* The in-page half of `block-drag-bench.mjs --device ios-app`. Evaluated inside
 * the real iOS app's editor WebView by BlockDragBenchProbe.swift (DEBUG builds);
 * ios-app.mjs prepends `const CONFIG = {...}` and `generateNote` (note.mjs) and
 * hands the result to the XCUITest runner. Real touches come from XCUITest
 * (BlockDragBenchTests.swift): this script shows a one-line command
 * `BENCH:<verb>:x:y:x2:y2:arg[:name]` the test reads off the accessibility
 * tree, records every frame and touch while the finger does it, and posts
 * metrics shaped like app-device.mjs's (lift / gap / scroll / drop frame).
 * Results go out through webkit.messageHandlers.futoBench, one JSON line each.
 * A run is only good if it ends in `finished` with no `error` record (ios-app.mjs
 * `validateRecords` enforces that); on a failure the probe still sends the test
 * its `done` command so the test ends instead of waiting out its deadline. */
(async () => {
  const post = (o) => window.webkit.messageHandlers.futoBench.postMessage(JSON.stringify(o));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  if (CONFIG.line) window.__futoBlockDragReflow = 'off';
  try {
    await run();
  } catch (e) {
    post({ kind: 'error', message: String((e && e.stack) || e) });
    command('done', 0, 0, 0, 0, 0);
  }

  async function waitFor(what, fn, ms = 60000) {
    const end = performance.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() > end) throw new Error('timeout: ' + what);
      await sleep(100);
    }
  }

  // ---- recorder ----
  const frames = [];
  let recording = false;
  const events = []; // {t, type}
  const loop = (t) => {
    if (!recording) return;
    frames.push(performance.now());
    requestAnimationFrame(loop);
  };
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    window.addEventListener(type, () => events.push({ t: performance.now(), type }), {
      capture: true,
      passive: true,
    });
  }
  // The preview on screen mid-drag, sampled from the touchmoves of the lift
  // story (a few DOM queries, not one per move). Mirrors preview-mode.ts.
  let modeSamples = null;
  let moveCount = 0;
  function previewMode() {
    const line = document.querySelector('.futo-mobile-dnd-indicator--visible') !== null;
    const reflow =
      document.querySelector('.futo-mobile-dnd-reflow-clip') !== null ||
      (!line &&
        Array.from(window.__futoProseMirrorView().dom.children).some((el) => el.style.transform));
    return line && !reflow ? 'line' : reflow && !line ? 'reflow' : 'unknown';
  }
  window.addEventListener(
    'touchmove',
    () => {
      if (!modeSamples) return;
      moveCount += 1;
      if (moveCount % 20 === 5 && document.querySelector('.futo-mobile-dnd-ghost')) {
        // An early move can land before the first preview is drawn: skip it.
        const m = previewMode();
        if (m !== 'unknown') modeSamples.push(m);
      }
    },
    { capture: true, passive: true },
  );
  let scrollTarget = null;
  const onScroll = () => events.push({ t: performance.now(), type: 'scroll' });
  const mo = new MutationObserver(() => {
    if (document.querySelector('.futo-mobile-dnd-ghost') && !events.some((e) => e.type === 'ghost'))
      events.push({ t: performance.now(), type: 'ghost' });
  });
  mo.observe(document.body, { childList: true, subtree: true });

  function startRecording() {
    frames.length = 0;
    events.length = 0;
    recording = true;
    requestAnimationFrame(loop);
  }
  const between = (a, b) => {
    const out = [];
    for (let i = 1; i < frames.length; i += 1)
      if (frames[i] > a && frames[i] <= b) out.push(frames[i] - frames[i - 1]);
    return out;
  };
  const ev = (type, nth = 0) => events.filter((e) => e.type === type)[nth]?.t;
  const last = (type) => events.filter((e) => e.type === type).at(-1)?.t;
  const max = (xs) => (xs.length ? Math.max(...xs) : null);
  const stats = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return {
      n: s.length,
      max: s.at(-1),
      p95: s[Math.floor(s.length * 0.95)],
      med: s[s.length >> 1],
    };
  };

  // ---- command channel to XCUITest ----
  let cmdEl = null;
  function command(verb, x, y, x2, y2, arg, name) {
    if (!cmdEl) {
      cmdEl = document.createElement('div');
      cmdEl.style.cssText =
        'position:fixed;left:0;bottom:0;z-index:2147483647;pointer-events:none;' +
        'font:9px monospace;background:#fff;color:#000;padding:1px';
      document.documentElement.appendChild(cmdEl);
    }
    const r = Math.round;
    cmdEl.textContent = `BENCH:${verb}:${r(x)}:${r(y)}:${r(x2)}:${r(y2)}:${r(arg)}${name ? ':' + name : ''}`;
  }
  const clearCommand = () => cmdEl && (cmdEl.textContent = '');
  async function runCommand(args, settleMs) {
    startRecording();
    await sleep(300);
    command(...args);
    // The test reads the element, performs the gesture, and waits for it to go.
    await waitFor(
      'touchend after ' + args[0],
      () => last('touchend') || last('touchcancel'),
      90000,
    );
    const tEnd = last('touchend') || last('touchcancel');
    clearCommand();
    await sleep(settleMs);
    recording = false;
    return tEnd;
  }

  async function run() {
    await waitFor(
      'editor view',
      () => window.__futoProseMirrorView && window.__futoProseMirrorView(),
    );
    await sleep(CONFIG.bootWaitMs);
    const info = {
      ua: navigator.userAgent,
      dpr: devicePixelRatio,
      vw: innerWidth,
      vh: innerHeight,
    };
    post({ kind: 'hello', ...info });

    for (let rep = 0; rep < CONFIG.repeat; rep += 1) {
      for (const blocks of CONFIG.sizes) {
        await one(blocks, rep);
      }
    }
    // `finished` first: the test ends the app as soon as it reads `done`.
    post({ kind: 'finished' });
    command('done', 0, 0, 0, 0, 0);
  }

  async function load(blocks) {
    const md = generateNote(blocks);
    window.FutoEditor.setContent('bench-note-' + blocks, '');
    await raf();
    window.FutoEditor.setContent('bench-note-' + blocks, md);
    const v = await waitFor(
      'the fixture to load',
      () => {
        const view = window.__futoProseMirrorView();
        return view.state.doc.childCount === blocks ? view : null;
      },
      180000,
    );
    document.activeElement?.blur?.();
    v.dom.blur();
    v.dom.scrollTop = 0;
    for (let i = 0; i < 10; i += 1) await raf();
    // Quiet: 600ms of frames all under 25ms; the idle interval is the vsync.
    const intervals = [];
    let quietSince = performance.now();
    let prev = await new Promise((r) => requestAnimationFrame(r));
    const deadline = performance.now() + 30000;
    while (performance.now() - quietSince < 800) {
      if (performance.now() > deadline) throw new Error('page never went quiet after load');
      const t = await new Promise((r) => requestAnimationFrame(r));
      if (t - prev > 25) quietSince = t;
      intervals.push(t - prev);
      prev = t;
    }
    intervals.sort((a, b) => a - b);
    return { view: v, vsync: intervals[intervals.length >> 1] };
  }

  function geometry(v) {
    const r = v.dom.getBoundingClientRect();
    const first = v.dom.children[0].getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, innerHeight);
    return {
      x: Math.round(r.left + r.width / 2),
      liftY: Math.round(first.top + first.height / 2),
      yA: Math.round(top + (bottom - top) * 0.45),
      yB: Math.round(top + (bottom - top) * 0.85),
      edgeY: Math.round(bottom - 14),
      top,
      bottom,
    };
  }

  async function one(blocks, rep) {
    const { view, vsync } = await load(blocks);
    const g = geometry(view);
    const base = { blocks, rep, vsync, geo: g };

    // The arm restyle itself, measured synchronously (WebKit adds this class at
    // every touch-down on a block; desktop Playwright WebKit: ~28/83 ms).
    {
      const C = 'futo-mobile-dnd-hide-selection';
      const arms = [];
      const disarms = [];
      for (let i = 0; i < 5; i += 1) {
        view.dom.getBoundingClientRect();
        let t = performance.now();
        view.dom.classList.add(C);
        getComputedStyle(view.dom.children[0]).color;
        view.dom.getBoundingClientRect();
        arms.push(performance.now() - t);
        t = performance.now();
        view.dom.classList.remove(C);
        getComputedStyle(view.dom.children[0]).color;
        view.dom.getBoundingClientRect();
        disarms.push(performance.now() - t);
        await raf();
      }
      post({ kind: 'arm-sync', ...base, arm: stats(arms), disarm: stats(disarms) });
    }

    // (a) long-press lift + slow drag through many slots, rest, release.
    {
      view.dom.scrollTop = 0;
      await raf();
      modeSamples = [];
      moveCount = 0;
      const tEnd = await runCommand(['lift', g.x, g.liftY, g.x, g.yB, 700], 4000);
      const seen = [...new Set(modeSamples)];
      modeSamples = null;
      const mode = seen.length === 1 ? seen[0] : 'unknown';
      const expected = CONFIG.line ? 'line' : 'reflow';
      if (mode !== expected)
        throw new Error(
          `asked for the ${expected} preview, page showed: ${seen.join(', ') || 'none'}`,
        );
      const tStart = ev('touchstart');
      const ghost = ev('ghost');
      const moves = events.filter((e) => e.type === 'touchmove' && e.t > (ghost ?? 1e12));
      const dragFrames = moves.length ? between(moves[0].t, moves.at(-1).t) : [];
      post({
        kind: 'lift',
        ...base,
        liftedAfterMs: ghost && tStart ? ghost - tStart : null,
        liftFrame: ghost && tStart ? max(between(tStart + 300, ghost + 300)) : null,
        dragFrames: stats(dragFrames),
        dragSamples: dragFrames,
        dropFrame: max(between(tEnd, tEnd + 3900)),
        moves: moves.length,
        mode,
        leftover:
          document.querySelectorAll('.futo-mobile-dnd-ghost, .futo-mobile-dnd-reflow-clip').length +
          Array.from(view.dom.children).filter((el) => el.style.transform).length,
      });
    }

    // (b) long-press, drag to the bottom edge, hold there: auto-scroll.
    {
      view.dom.scrollTop = 0;
      await raf();
      const before = view.dom.scrollTop;
      scrollTarget = view.dom;
      const sc0 = view.dom.scrollTop;
      view.dom.addEventListener('scroll', onScroll, { passive: true });
      const tEnd = await runCommand(['edge', g.x, g.liftY, g.x, g.edgeY, 1800], 4000);
      view.dom.removeEventListener('scroll', onScroll);
      const s0 = ev('scroll');
      const s1 = last('scroll');
      const scrollFrames = s0 && s1 && s1 > s0 ? between(s0, Math.min(s1, tEnd)) : [];
      post({
        kind: 'edge',
        ...base,
        scrolledPx: Math.round(view.dom.scrollTop - sc0),
        scrollFrames: stats(scrollFrames),
        scrollSamples: scrollFrames,
        dropFrame: max(between(tEnd, tEnd + 3900)),
        before,
      });
    }

    // (c) touch down on a block then an ordinary scroll (arm cost per scroll).
    {
      view.dom.scrollTop = 0;
      await raf();
      const tEnd = await runCommand(['scroll', g.x, g.yB, g.x, g.top + 40, 1200], 1500);
      const tStart = ev('touchstart');
      post({
        kind: 'scroll-arm',
        ...base,
        armWindowFrame: max(between(tStart, tStart + 250)),
        scrollWindow: stats(between(tStart, tEnd)),
        afterEndFrame: max(between(tEnd, tEnd + 1000)),
      });
    }

    // Selection race, once per size 1000 only (state-independent).
    if (blocks === CONFIG.sizes[0] && rep === 0 && CONFIG.selection) await selectionRace(blocks);
  }

  async function selectionRace(blocks) {
    // The earlier stories drop blocks into new places, so block 1 is no longer
    // the fixture's first paragraph. Start from a fresh copy and find the
    // paragraph by its content (generateNote: block 1 holds **bold 1**, _italic_,
    // a link to /1); a missing target fails the run instead of being skipped.
    const { view } = await load(blocks);
    view.dom.scrollTop = 0;
    await raf();
    const block = Array.from(view.dom.children).find(
      (el) => el.querySelector('strong')?.textContent === 'bold 1',
    );
    if (!block)
      throw new Error('selection: the fixture paragraph with **bold 1** is not in the doc');
    const centre = (el) => {
      const rs = el.getClientRects();
      const r = rs[0];
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const kinds = [
      ['strong', block.querySelector('strong')],
      ['em', block.querySelector('em')],
      ['link', block.querySelector('a[href$="/1"]')],
      ['plain', block],
    ];
    for (const [name, el] of kinds) {
      if (!el) throw new Error(`selection: no ${name} element in the fixture paragraph`);
      let p = centre(el);
      if (p.y < 0 || p.y > innerHeight - 20)
        throw new Error(`selection: the ${name} target is off screen (y ${Math.round(p.y)})`);
      if (name === 'plain') {
        const r = block.getBoundingClientRect();
        p = { x: r.left + 24, y: r.top + 10 };
      }
      const tEnd = await runCommand(['hold', p.x, p.y, p.x, p.y, 2600, 'hold-' + name], 1000);
      const sel = getSelection();
      post({
        kind: 'selection',
        name,
        selectedText: sel.toString(),
        rangeCount: sel.rangeCount,
        collapsed: sel.isCollapsed,
        lifted: ev('ghost') != null,
        focused: view.hasFocus(),
      });
      view.dom.blur();
      await sleep(500);
    }
    // A tap afterwards places the caret.
    const r = block.getBoundingClientRect();
    await runCommand(['tap', r.left + 40, r.top + 10, 0, 0, 0], 800);
    // tap has no touch-end detection issue: touchend fires as well.
    const sel = getSelection();
    post({
      kind: 'tap',
      collapsed: sel.isCollapsed,
      focused: view.hasFocus(),
      inBlock: !!sel.anchorNode && block.contains(sel.anchorNode),
      anchorOffset: sel.anchorOffset,
    });
    view.dom.blur();
  }
})();
