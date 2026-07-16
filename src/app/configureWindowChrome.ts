import { isLinux, isMac, isTauri } from '$lib/platform';

// nav.md §Desktop shell: Linux renders a 36px custom titlebar; macOS overlays
// the native traffic lights on our chrome and the top band reserves a fixed
// leading gutter for them. Both are expressed as CSS custom properties consumed
// by desktop-shell.css / app-shell.css so the reservation lives in one place,
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
