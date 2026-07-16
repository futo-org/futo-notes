import { isDesktop, isLinux, isMac } from '$lib/platform';

export function configureWindowChrome(): boolean {
  const root = document.documentElement;
  const showCustomTitleBar = isDesktop && isLinux;

  if (showCustomTitleBar) {
    root.style.setProperty('--titlebar-height', '36px');
  }

  // macOS overlays the native traffic lights on our own chrome
  // (`titleBarStyle: "Overlay"`, `trafficLightPosition: { x: 19, y: 20 }`).
  // The full-width desktop top band reserves a fixed leading gutter for them
  // that is independent of sidebar state (see `.topband-chrome` /
  // `--macos-traffic-lights-width` in desktop-shell.css) — the single place
  // that clears the buttons, so collapsing the sidebar can no longer expose
  // or crowd them.
  //
  // `--macos-traffic-lights-width` (96px): the gutter width. Three buttons
  // start at x≈19 with ~20px spacing, landing the rightmost light at ~x=71;
  // 96px leaves a clear gap after it.
  // `--tabs-strip-height` (48px): the top-band height, seating the lights
  // (top at y=20, ~12px tall) centered with margin above and below.
  // Off macOS both are 0 / unset and the band falls back to a plain 40px strip.
  if (isDesktop && isMac) {
    root.style.setProperty('--macos-traffic-lights-width', '96px');
    root.style.setProperty('--tabs-strip-height', '48px');
  } else {
    root.style.setProperty('--macos-traffic-lights-width', '0px');
  }

  return showCustomTitleBar;
}
