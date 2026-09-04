import { isLinux, readDesktopColorScheme, setNativeWindowAppearance } from '$lib/platform';

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
 *   the portal — the `linux-theme-changed` event `watchSystemThemeTauri`
 *   listens for, and the `readDesktopColorScheme` read `resolveAutoTheme` does.
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
 * Off Linux this is the reported system appearance, or the page's own
 * `prefers-color-scheme` — a signal macOS and Windows never overwrite, because
 * their `auto` hands the window back to the OS (see `windowAppearanceFor`).
 *
 * On Linux the page is NOT that signal. `auto` has to pin the window there, and
 * any pin writes `gtk-application-prefer-dark-theme`, which is the same property
 * WebKitGTK answers `prefers-color-scheme` from — so the query reads back the
 * app's own last choice. Measured on Fedora 44 / KDE Plasma 6.7.4: on a dark
 * desktop, choosing Light and then Auto left the app light, because `auto`
 * believed the value Light had just written. The xdg portal's
 * `org.freedesktop.appearance` / `color-scheme` is the desktop's answer and
 * nothing this app does can overwrite it, so on Linux that comes first, with the
 * reported change and then the media query as fallbacks for a desktop that has
 * no portal to ask.
 */
export async function resolveAutoTheme(
  systemThemeOverride?: ResolvedTheme,
  linux: boolean = isLinux,
): Promise<ResolvedTheme> {
  if (!linux) return systemThemeOverride ?? resolveTheme('auto');
  return (await readDesktopColorScheme()) ?? systemThemeOverride ?? resolveTheme('auto');
}

export async function applyThemePreference(
  preference: ThemePreference,
  systemThemeOverride?: ResolvedTheme,
): Promise<ResolvedTheme> {
  const resolved =
    preference === 'auto' ? await resolveAutoTheme(systemThemeOverride) : resolveTheme(preference);
  applyResolvedTheme(resolved);
  setNativeWindowAppearance(windowAppearanceFor(preference, resolved));
  await syncStatusBarTheme(resolved);
  return resolved;
}

export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  const media = window.matchMedia(SYSTEM_DARK_MEDIA);
  const handler = () => onChange();
  media.addEventListener('change', handler);
  return () => media.removeEventListener('change', handler);
}

export function watchSystemThemeTauri(onChange: (theme?: ResolvedTheme) => void): () => void {
  let tauriUnlisten: (() => void) | null = null;
  let portalUnlisten: (() => void) | null = null;
  let fallbackUnlisten: (() => void) | null = null;
  let disposed = false;

  import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => {
      if (disposed) return;
      void getCurrentWindow()
        .onThemeChanged(({ payload: theme }) => {
          onChange(theme as ResolvedTheme);
        })
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          tauriUnlisten = unlisten;
        });

      import('@tauri-apps/api/event')
        .then(({ listen }) => {
          if (disposed) return;
          void listen<string>('linux-theme-changed', (event) => {
            onChange(event.payload as ResolvedTheme);
          }).then((unlisten) => {
            if (disposed) {
              unlisten();
              return;
            }
            portalUnlisten = unlisten;
          });
        })
        .catch(() => {});
    })
    .catch(() => {
      if (disposed) return;
      fallbackUnlisten = watchSystemTheme(onChange);
    });

  return () => {
    if (disposed) return;
    disposed = true;
    const t = tauriUnlisten;
    tauriUnlisten = null;
    const p = portalUnlisten;
    portalUnlisten = null;
    const f = fallbackUnlisten;
    fallbackUnlisten = null;
    t?.();
    p?.();
    f?.();
  };
}

async function syncStatusBarTheme(theme: ResolvedTheme): Promise<void> {
  void theme;
}
