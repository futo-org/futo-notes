/* Which block-drag preview is on screen right now, read mid-drag by the
 * benchmark pages so a run reports the mode it SAW, not the one it asked for
 * (`block-drag-bench/variant.mjs` `assertModes` compares the two). `line` is the
 * drop-line indicator; `reflow` is the curtain (`.futo-mobile-dnd-reflow-clip`)
 * or, in a file from before the curtain, blocks carrying a transform. Anything
 * else (nothing drawn, or both) is `unknown`, which fails the run. The same
 * test is inlined in app-device.mjs and ios-probe.js, which are not bundled. */
export function previewMode(dom: HTMLElement): 'line' | 'reflow' | 'unknown' {
  const line = document.querySelector('.futo-mobile-dnd-indicator--visible') !== null;
  const reflow =
    document.querySelector('.futo-mobile-dnd-reflow-clip') !== null ||
    Array.from(dom.children).some((el) => (el as HTMLElement).style.transform);
  if (line && !reflow) return 'line';
  if (reflow && !line) return 'reflow';
  return 'unknown';
}
