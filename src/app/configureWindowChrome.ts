import { getWindowControlsLayout, isLinux, isMac, isTauri } from '$lib/platform';

// nav.md §Desktop shell: expose the chrome reservation as CSS custom properties
// (consumed by desktop-shell.css / app-shell.css) so it lives in one place,
// independent of sidebar state.
export const MACOS_TRAFFIC_LIGHTS_WIDTH = '73px';

// Marks the document as the desktop application shell. Desktop-only chrome
// rules (src/styles/desktop-native.css) hang off this instead of
// `.notes-shell.desktop-layout`, because popovers, dialogs and the settings
// screen render OUTSIDE the shell element — and because app.css is shared with
// the native iOS/Android editor embed, which must never match.
export const DESKTOP_CHROME_CLASS = 'desktop-chrome';

export function configureWindowChrome(): { dispose: () => void } {
  const root = document.documentElement;
  let disposed = false;

  if (isTauri) {
    root.classList.add(DESKTOP_CHROME_CLASS);
  }
  if (isTauri && isMac) {
    root.style.setProperty('--macos-traffic-lights-width', MACOS_TRAFFIC_LIGHTS_WIDTH);
  }
  if (isTauri && isLinux) {
    void getWindowControlsLayout()
      .then((layout) => {
        if (disposed || !layout?.left.length) return;
        const buttonsWidth = layout.left.length * 24;
        const gapsWidth = Math.max(0, layout.left.length - 1) * 2;
        root.style.setProperty(
          '--linux-window-controls-width',
          `${buttonsWidth + gapsWidth + 10}px`,
        );
      })
      .catch((error) => console.warn('Failed to reserve Linux window controls:', error));
  }

  return {
    dispose() {
      disposed = true;
      root.classList.remove(DESKTOP_CHROME_CLASS);
      root.style.removeProperty('--macos-traffic-lights-width');
      root.style.removeProperty('--linux-window-controls-width');
    },
  };
}
