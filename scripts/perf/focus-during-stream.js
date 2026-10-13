// --eval-file probe for tests/android-editor-perf-quick.mjs: the FIRST tap while
// the progressive tail is still streaming. `measureExpression`'s first focus
// runs only after open-complete, so it cannot see this case.
//
// Per fixture, REPS times: empty the editor, setContent (chunk 0 lands
// synchronously), focus right away and time three frames (the gate's unit),
// then one keystroke dispatched into the still-streaming document timed to
// the next frame, then wait for open-complete. Reports medians and p90 per
// fixture plus the raw samples. Numbers and method: docs/perf/note-open-focus.md.
const repsFor = (name) => (name === 'real-note' ? 4 : 6);
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = () => window.__futoTest.documentRef().noteId;
const entry = (name) => performance.getEntriesByName(name)[0]?.duration ?? null;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    median: Math.round(q(0.5)),
    p90: Math.round(q(0.9)),
    samples: s.map((x) => Math.round(x)),
  };
};
const out = {};
for (const name of Object.keys(FIXTURES)) {
  const md = FIXTURE(name);
  const focusMs = [],
    keyMs = [],
    interactiveMs = [],
    completeMs = [],
    tailLeftAtFocus = [];
  for (let r = 0; r < repsFor(name); r += 1) {
    window.FutoEditor.setContent(id(), '');
    await raf();
    await raf();
    const view = window.__futoProseMirrorView?.();
    view.dom.blur();
    await sleep(100);
    window.FutoEditor.setContent(id(), md);
    // Chunk 0 is in. A real tap arrives a frame or two later; give it one.
    await raf();
    const sizeAtFocus = view.state.doc.content.size;
    const t0 = performance.now();
    view.focus();
    for (let i = 0; i < 3; i += 1) await raf();
    focusMs.push(performance.now() - t0);
    if (!view.hasFocus()) throw new Error('editor did not take focus');
    // One keystroke into the streaming document, timed to the next frame.
    const t1 = performance.now();
    view.dispatch(view.state.tr.insertText('x'));
    await raf();
    keyMs.push(performance.now() - t1);
    const deadline = performance.now() + 180000;
    while (!entry('futo:editor-open-complete')) {
      if (performance.now() > deadline) throw new Error('open never completed');
      await sleep(25);
    }
    tailLeftAtFocus.push(Math.round((1 - sizeAtFocus / view.state.doc.content.size) * 100));
    interactiveMs.push(entry('futo:editor-open-interactive'));
    completeMs.push(entry('futo:editor-open-complete'));
    view.dom.blur();
    await raf();
  }
  out[name] = {
    focusDuringStreamMs: stats(focusMs),
    keystrokeDuringStreamMs: stats(keyMs),
    interactiveMs: stats(interactiveMs),
    completeMs: stats(completeMs),
    tailStillToStreamAtFocusPct: stats(tailLeftAtFocus),
  };
}
return out;
