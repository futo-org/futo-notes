import { EditorView } from '@codemirror/view';

/**
 * CM6's synchronous measure cycle: recomputes the viewport for the current
 * scroll position, updates the rendered DOM, and records real line heights into
 * the height map — all synchronously. Warming relies on this being synchronous
 * (each region must be measured before we step to the next), unlike the public
 * `requestMeasure`, which defers to the next animation frame. `measure()` is a
 * long-standing, stable EditorView method but isn't in the published `.d.ts`, so
 * we reach it through a narrow cast.
 */
function forceMeasure(view: EditorView): void {
  (view as unknown as { measure(flush?: boolean): void }).measure();
}

/**
 * Pre-measure every line's real height so CodeMirror's height map is accurate
 * before the user scrolls — eliminating the mid-scroll "jump forward and stop"
 * jank on iOS.
 *
 * Why this exists
 * ---------------
 * CM6 virtualizes: off-screen lines get an ESTIMATED height (~1 line-height
 * each). A long paragraph that WRAPS to N visual lines in a proportional font is
 * therefore under-estimated by ~(N-1) line-heights. When you scroll that
 * paragraph into the measured range, CM6 measures it taller, grows the height
 * map, and — to keep its scroll anchor pinned — writes `scrollDOM.scrollTop +=
 * diff` (EditorView.measure, the `scroll.scrollTop += diff` branch). On a
 * desktop wheel scroller that reposition is invisible. On an iOS touch-momentum
 * scroller, ANY programmatic scrollTop write CANCELS the in-flight momentum, so
 * the scroll lurches forward by `diff` and dead-stops. Harder flicks sweep more
 * unmeasured paragraphs into range per frame → bigger `diff` → worse. There is
 * no CM6 facet to disable that correction (the write is gated on a touch within
 * the last 100ms, which is always true mid-flick).
 *
 * The fix
 * -------
 * Measured heights are RETAINED once taken — CM6 only reverts a measured line to
 * an estimate when the DOCUMENT changes that range, never on scroll-away (see
 * HeightMapText.updateHeight: it keeps its height unless `force || outdated`).
 * So if we walk the viewport across the whole doc once, every line gets measured
 * and STAYS measured; afterwards the anchor `diff` is ~0 and the momentum-killing
 * write never happens.
 *
 * We do this SYNCHRONOUSLY and via CM6's OWN scroll mechanism: dispatch
 * `EditorView.scrollIntoView(pos, {y:'start'})` to bring each successive region
 * to the top, force a synchronous measure cycle so its real heights are recorded,
 * then advance `pos` to the bottom of the freshly-rendered viewport and repeat.
 * We use `scrollIntoView` rather than writing `scrollDOM.scrollTop` directly
 * because a fresh load pins the scroll anchor near the top — a raw scrollTop
 * write gets reverted on the next measure (the very anchor correction we're
 * fighting), so the viewport never actually moves and nothing gets measured.
 * `scrollIntoView` re-targets the anchor, so it sticks. We restore the original
 * scroll position at the end.
 *
 * Re-run after anything that re-flows wrap widths (width resize / rotation /
 * font load) — that's the only thing besides an edit that invalidates the map.
 *
 * @returns how much the document's scrollHeight grew during warming — i.e. the
 *   total estimation error that WOULD have manifested as scroll jank. ~0 means
 *   the map was already accurate (a no-op re-warm). Used by tests and the
 *   dev diag to quantify before/after.
 */
export function warmHeightMap(view: EditorView): { grew: number; steps: number } {
  const scroller = view.scrollDOM;
  const restore = scroller.scrollTop;
  const startHeight = scroller.scrollHeight;
  const docLen = view.state.doc.length;

  let pos = 0; // doc position currently parked at the top of the viewport
  let steps = 0;
  let lastPos = -1;
  // Bounded loop: each step advances `pos` to the bottom of the just-rendered
  // viewport, so it tiles the whole doc; the cap is a safety net.
  for (let i = 0; i < 400; i++) {
    view.dispatch({ effects: EditorView.scrollIntoView(Math.min(pos, docLen), { y: 'start' }) });
    // Synchronously render+measure the region now at the top so its real line
    // heights land in the height map (and persist).
    forceMeasure(view);
    steps++;
    if (pos >= docLen) break;
    // Advance to the doc position at the bottom of the rendered viewport. Uses
    // the (now partly-measured) height map; converges as estimates resolve.
    let nextPos = pos;
    try {
      const vpBottom = scroller.scrollTop + scroller.clientHeight;
      nextPos = view.lineBlockAtHeight(vpBottom).to;
    } catch {
      nextPos = docLen;
    }
    // Guarantee forward progress even if a block is taller than the viewport.
    if (nextPos <= pos) nextPos = pos + 1;
    if (nextPos === lastPos) break;
    lastPos = pos;
    pos = Math.min(nextPos, docLen);
  }

  const grew = Math.round(scroller.scrollHeight - startHeight);

  // Put the viewport back where it started (a fresh note load is at the top).
  view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start' }) });
  forceMeasure(view);
  if (scroller.scrollTop !== restore) {
    scroller.scrollTop = restore;
    forceMeasure(view);
  }

  return { grew, steps };
}
