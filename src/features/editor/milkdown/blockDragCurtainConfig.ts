/**
 * TEST/BENCH-ONLY switch, read when a drag starts: `?blockDragReflow=off` in
 * the page URL, or `window.__futoBlockDragReflow = 'off'` set before the drag
 * (the block-drag bench injects it for its `:line` variants), forces the drop
 * line for top-level blocks too. Never set by production hosts.
 */
export function reflowForcedOff(win: Window): boolean {
  try {
    if ((win as Window & { __futoBlockDragReflow?: string }).__futoBlockDragReflow === 'off') {
      return true;
    }
    return new URLSearchParams(win.location.search).get('blockDragReflow') === 'off';
  } catch {
    return false;
  }
}

/**
 * TEST-ONLY switch, read at each release: `window.__futoBlockDragLandCap =
 * 'off'` lets a landing drop wait on its slides past LAND_CAP_MS, so a test
 * that stops the animation clock mid-slide can look at the landing for as
 * long as it needs. Never set by production hosts.
 */
export function landCapOff(win: Window): boolean {
  return (win as Window & { __futoBlockDragLandCap?: string }).__futoBlockDragLandCap === 'off';
}

/** The blocks within REFLOW_WINDOW_URGENT_VIEWPORTS of the visible area are
 * cloned in the frame that needs them; the rest of the window, out to
 * REFLOW_WINDOW_MARGIN_VIEWPORTS on each side, is cloned in idle time between
 * frames, a few at a time (`scheduleFill`). A clone is dropped once it is
 * REFLOW_WINDOW_DROP_VIEWPORTS away. Cloning a whole window in one frame cost
 * the frame that opened the curtain ~45ms on a budget phone, and a steady
 * auto-scroll a long frame every viewport. */
export const REFLOW_WINDOW_URGENT_VIEWPORTS = 0.25;
export const REFLOW_WINDOW_MARGIN_VIEWPORTS = 1.5;
export const REFLOW_WINDOW_DROP_VIEWPORTS = 3;
/** Idle-time cloning stops with this much of the idle period left. */
export const CURTAIN_FILL_RESERVE_MS = 2;
/** The longest the curtain waits for idle time after a lift. */
export const CURTAIN_IDLE_OPEN_TIMEOUT_MS = 150;
/** The longest a pending idle fill waits. */
export const CURTAIN_FILL_TIMEOUT_MS = 300;
/** Where there is no `requestIdleCallback` (`whenIdle`): how long to wait,
 * and how much time the stand-in idle period offers. */
export const IDLE_FALLBACK_DELAY_MS = 32;
export const IDLE_FALLBACK_SLICE_MS = 4;
export const REFLOW_TRANSITION = 'transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1)';
/** The longest a release waits for its slides to end before it commits
 * (`land`): well past the slide's own 0.18s, for when no `transitionend`
 * comes. A stopped animation clock (the app sent to the background mid-slide)
 * or a hidden curtain never ends a slide. Exported for the tests. */
export const LAND_CAP_MS = 400;

/** The curtain's rules, spliced into the session's one-time stylesheet. */
export const CURTAIN_STYLES = `
    /* Live reflow (\`ReflowCurtain\`): the clip sits over the scroll box's visible
     * area, under the ghost card; the curtain inside it carries the ProseMirror
     * class for the content typography, with the editor's box rules zeroed. */
    .futo-mobile-dnd-reflow-clip {
      position: fixed;
      overflow: hidden;
      pointer-events: none;
      z-index: 998;
    }
    .futo-milkdown .futo-mobile-dnd-reflow-clip .futo-mobile-dnd-reflow-curtain.ProseMirror {
      position: absolute;
      top: 0;
      box-sizing: border-box;
      min-height: 0;
      margin: 0;
      padding: 0;
      border: 0;
      overflow: visible;
      outline: none;
      will-change: transform;
    }
    /* Each clone on its own compositor layer, so its slide runs on the
     * compositor: without it Chromium ticked every sliding clone on the main
     * thread, 3-5ms a frame on a budget phone. */
    .futo-milkdown .futo-mobile-dnd-reflow-curtain.ProseMirror > * {
      position: absolute;
      box-sizing: border-box;
      margin: 0;
      transition: ${REFLOW_TRANSITION};
      will-change: transform;
    }
    .futo-milkdown .futo-mobile-dnd-reflow-curtain.ProseMirror > .futo-mobile-dnd-reflow-source {
      opacity: 0.35;
    }
  `;
