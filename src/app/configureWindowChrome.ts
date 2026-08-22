import { isLinux, isMac, isTauri } from '$lib/platform';

// nav.md §Desktop shell: expose the chrome reservation as CSS custom properties
// (consumed by desktop-shell.css / app-shell.css) so it lives in one place,
// independent of sidebar state.
export const MACOS_TRAFFIC_LIGHTS_WIDTH = '73px';
const LINUX_TITLEBAR_HEIGHT = '36px';

// Marks the document as the desktop application shell. Desktop-only chrome
// rules (src/styles/desktop-native.css) hang off this instead of
// `.notes-shell.desktop-layout`, because popovers, dialogs and the settings
// screen render OUTSIDE the shell element — and because app.css is shared with
// the native iOS/Android editor embed, which must never match.
export const DESKTOP_CHROME_CLASS = 'desktop-chrome';

export interface WindowChrome {
  showLinuxTitlebar: boolean;
}

export function configureWindowChrome(): { chrome: WindowChrome; dispose: () => void } {
  const root = document.documentElement;
  let showLinuxTitlebar = false;

  if (isTauri) {
    root.classList.add(DESKTOP_CHROME_CLASS);
  }
  if (isTauri && isMac) {
    root.style.setProperty('--macos-traffic-lights-width', MACOS_TRAFFIC_LIGHTS_WIDTH);
  }
  if (isTauri && isLinux) {
    root.style.setProperty('--titlebar-height', LINUX_TITLEBAR_HEIGHT);
    showLinuxTitlebar = true;
  }

  return {
    chrome: { showLinuxTitlebar },
    dispose() {
      root.classList.remove(DESKTOP_CHROME_CLASS);
      root.style.removeProperty('--macos-traffic-lights-width');
      root.style.removeProperty('--titlebar-height');
    },
  };
}
