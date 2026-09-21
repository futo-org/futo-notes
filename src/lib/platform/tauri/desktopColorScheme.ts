import { invoke } from '@tauri-apps/api/core';

/**
 * The DESKTOP's light/dark preference — not the window's, and not the page's.
 *
 * Read from the xdg desktop portal (`org.freedesktop.appearance` /
 * `color-scheme`) on Linux, where it is the only light/dark signal this app
 * cannot overwrite; `null` on every other platform, whose `auto` leaves the
 * window following the OS and so keeps `prefers-color-scheme` trustworthy.
 */
export function readDesktopColorScheme(): Promise<'dark' | 'light' | null> {
  return invoke<'dark' | 'light' | null>('read_desktop_color_scheme');
}
