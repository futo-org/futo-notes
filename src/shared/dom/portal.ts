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
