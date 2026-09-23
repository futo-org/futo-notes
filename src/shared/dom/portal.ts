/**
 * Move a node to the document body so it paints above the app shell, and, while
 * it is mounted, suppress overlay scrollbars everywhere (see below).
 */

/** Scrollbars that take no layout width — WebKitGTK's GTK indicator, macOS. */
let overlayScrollbars: boolean | null = null;
let mountedPortals = 0;

function usesOverlayScrollbars(): boolean {
  if (overlayScrollbars !== null) return overlayScrollbars;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';
  document.body.appendChild(probe);
  overlayScrollbars = probe.offsetWidth - probe.clientWidth === 0;
  probe.remove();
  return overlayScrollbars;
}

/**
 * WebKit paints an overlay scrollbar in a final pass over the whole page, after
 * everything else — so the sidebar's scrollbar landed on top of an open context
 * menu on Ubuntu (reported 2026-09-16), however high the menu's z-index. No
 * stacking or compositing change beats that pass; the scrollbar has to not be
 * there. Hiding it costs nothing while a menu is up: an overlay scrollbar is
 * already transient, and it reserves no space, so nothing reflows.
 *
 * A classic scrollbar (Windows, Linux with `GTK_OVERLAY_SCROLLING=0`) paints in
 * normal order and stays below the menu on its own, so it is left alone —
 * hiding one would reflow the list the moment a menu opened.
 */
function trackPortal(delta: number): void {
  if (!usesOverlayScrollbars()) return;
  mountedPortals = Math.max(0, mountedPortals + delta);
  if (mountedPortals > 0) {
    document.documentElement.setAttribute('data-overlay-open', '');
  } else {
    document.documentElement.removeAttribute('data-overlay-open');
  }
}

export function portal(node: HTMLElement, target: HTMLElement | null = null) {
  const dest = target ?? (typeof document !== 'undefined' ? document.body : null);
  if (dest && node.parentNode !== dest) {
    dest.appendChild(node);
  }
  trackPortal(1);
  return {
    destroy() {
      node.remove();
      trackPortal(-1);
    },
  };
}
