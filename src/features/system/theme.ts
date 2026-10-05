import { isLinux, readSystemTheme, setNativeWindowAppearance } from '$lib/platform';

export type ThemePreference = 'auto' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const SYSTEM_DARK_MEDIA = '(prefers-color-scheme: dark)';

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia(SYSTEM_DARK_MEDIA).matches ? 'dark' : 'light';
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/**
 * Which appearance the WINDOW should wear for a given app-theme preference.
 *
 * The theme is not only a stylesheet: the OS draws the window frame in the
 * window's appearance, so an explicit preference is pinned to make the frame,
 * the app menu and native dialogs match the app.
 *
 * `null` means "hand the window back to the OS", and on macOS and Windows
 * `auto` needs exactly that. Pinning a preferred theme there stops the platform
 * reporting later system light/dark switches — AppKit because tao decides
 * whether to emit ThemeChanged by re-reading NSApp.effectiveAppearance, which a
 * pin freezes; Win32 because tao's WM_SETTINGCHANGE handler returns early while
 * a preferred theme is set — so `auto` would stop following the system it
 * exists to follow. The two agree there by definition anyway.
 *
 * GTK has neither half of that, so Linux gets the resolved value instead:
 *
 * - tao's Linux `set_theme` maps BOTH `None` and `Some(Light)` onto
 *   `gtk-application-prefer-dark-theme = false`. `null` does not mean "follow
 *   the desktop" there; it means "prefer light".
 * - WebKitGTK derives the page's own `prefers-color-scheme` from that same GTK
 *   property, so `null` overwrites the signal `resolveTheme('auto')` reads.
 *   Measured on Fedora 44 / WebKitGTK 2.52.5 against a dark GTK desktop: this
 *   app rendered LIGHT (data-theme=light, prefers-color-scheme false) where the
 *   pre-change build rendered dark.
 * - Nothing is lost by pinning, because the page was never the signal: tao
 *   emits no ThemeChanged on Linux at all, and `prefers-color-scheme` there
 *   only reads back the pin. The desktop's own answer reaches the app through
 *   the portal — the `linux-theme-changed` event `watchSystemTheme` listens
 *   for, and the `readSystemTheme` read `resolveAutoTheme` does.
 */
export function windowAppearanceFor(
  preference: ThemePreference,
  resolved: ResolvedTheme,
  linux: boolean = isLinux,
): ResolvedTheme | null {
  if (preference !== 'auto') return resolved;
  return linux ? resolved : null;
}

/**
 * What `auto` resolves to right now.
 *
 * The page's `prefers-color-scheme` is NOT the system's answer once the app has
 * pinned an appearance: the webview answers it from the window, so right after
 * an explicit choice the query reads back that choice. Measured on Fedora 44 /
 * KDE Plasma 6.7.4, choosing Light and then Auto on a dark desktop left the app
 * light; measured on macOS 26, choosing Dark and then Auto on a light desktop
 * left it dark, and tao emits no ThemeChanged for the app's own unpin that
 * would have corrected it. So the OS is asked directly — the xdg portal on
 * Linux, the released window's theme on macOS and Windows — with the reported
 * change and then the media query as fallbacks where nothing answers.
 */
export async function resolveAutoTheme(
  systemThemeOverride?: ResolvedTheme,
): Promise<ResolvedTheme> {
  return (await readSystemTheme()) ?? systemThemeOverride ?? resolveTheme('auto');
}

// Serialises overlapping applies. One desktop theme change is a BURST of portal
// signals — five on the KDE flip this was measured against — and resolving each
// of them now crosses to the portal, so an apply can still be in flight when
// the next starts. Without this, whichever RESOLVED last won, and a stale answer
// could latch both the wrong theme and the wrong window pin behind it.
let latestApply = 0;

export async function applyThemePreference(
  preference: ThemePreference,
  systemThemeOverride?: ResolvedTheme,
): Promise<ResolvedTheme> {
  const apply = ++latestApply;
  const resolved =
    preference === 'auto' ? await resolveAutoTheme(systemThemeOverride) : resolveTheme(preference);
  if (apply !== latestApply) return resolved;
  applyResolvedTheme(resolved);
  setNativeWindowAppearance(windowAppearanceFor(preference, resolved));
  return resolved;
}
