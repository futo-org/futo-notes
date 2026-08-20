import { setNativeWindowAppearance } from '$lib/platform';

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

export async function applyThemePreference(
  preference: ThemePreference,
  systemThemeOverride?: ResolvedTheme,
): Promise<ResolvedTheme> {
  const resolved =
    preference === 'auto' && systemThemeOverride ? systemThemeOverride : resolveTheme(preference);
  applyResolvedTheme(resolved);
  // The theme is not only a stylesheet: the OS draws the window frame in the
  // window's appearance (see setNativeWindowAppearance). An explicit preference
  // is pinned so the frame, the app menu and native dialogs match the app.
  //
  // `auto` deliberately hands the window back to the OS instead of pinning the
  // resolved value. The two agree there by definition, and pinning would
  // silence the very signal `auto` follows: tao decides whether to emit
  // ThemeChanged by re-reading NSApp.effectiveAppearance, which a pin freezes,
  // so a later system light/dark switch would never reach
  // `watchSystemThemeTauri` below.
  setNativeWindowAppearance(preference === 'auto' ? null : resolved);
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
