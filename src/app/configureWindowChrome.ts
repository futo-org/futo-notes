import { isLinux, isMac, isTauri } from '$lib/platform';

// nav.md §Desktop shell: expose the chrome reservation as CSS custom properties
// (consumed by desktop-shell.css / app-shell.css) so it lives in one place,
// independent of sidebar state.
const MACOS_TRAFFIC_LIGHTS_WIDTH = '78px';
const LINUX_TITLEBAR_HEIGHT = '36px';

export interface WindowChrome {
  showLinuxTitlebar: boolean;
}

export function configureWindowChrome(): { chrome: WindowChrome; dispose: () => void } {
  const root = document.documentElement;
  let showLinuxTitlebar = false;

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
      root.style.removeProperty('--macos-traffic-lights-width');
      root.style.removeProperty('--titlebar-height');
    },
  };
}
