/**
 * Re-parent a node to document.body so position:fixed escapes any
 * transformed/filtered ancestor. The mobile drawer uses
 * `transform: translateX(...)` which silently turns every descendant's
 * position:fixed into "fixed within the drawer", so modals and context
 * menus rendered inside the sidebar end up offset and clipped to the
 * sidebar's bounds. Wrapping the modal root with `use:portal` moves it
 * to document.body for the lifetime of the component.
 */
export function portal(node: HTMLElement, target: HTMLElement | null = null) {
  const dest = target ?? (typeof document !== 'undefined' ? document.body : null);
  if (dest && node.parentNode !== dest) {
    dest.appendChild(node);
  }
  return {
    destroy() {
      node.remove();
    },
  };
}
