import { isDesktop, isLinux, isMac } from '$lib/platform';

export function configureWindowChrome(): boolean {
  const root = document.documentElement;
  const showCustomTitleBar = isDesktop && isLinux;

  if (showCustomTitleBar) {
    root.style.setProperty('--titlebar-height', '36px');
  }

  // These values align the tab strip and sidebar with Tauri's overlaid macOS
  // traffic lights (`trafficLightPosition: { x: 19, y: 20 }`). The width also
  // keeps collapsed-sidebar controls clear of the native buttons.
  if (isDesktop && isMac) {
    root.style.setProperty('--macos-titlebar-inset', '32px');
    root.style.setProperty('--macos-traffic-lights-width', '96px');
    root.style.setProperty('--tabs-strip-height', '48px');
  } else {
    root.style.setProperty('--macos-titlebar-inset', '0px');
    root.style.setProperty('--macos-traffic-lights-width', '0px');
  }

  return showCustomTitleBar;
}
