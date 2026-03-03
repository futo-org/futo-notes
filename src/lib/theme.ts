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
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export async function applyThemePreference(preference: ThemePreference): Promise<ResolvedTheme> {
  const resolved = resolveTheme(preference);
  applyResolvedTheme(resolved);
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

/**
 * Watch system theme using Tauri's onThemeChanged event, which fires reliably
 * on Linux (webkit2gtk doesn't fire matchMedia change events).
 * Falls back to matchMedia if the Tauri API isn't available.
 */
export function watchSystemThemeTauri(onChange: () => void): () => void {
  let tauriUnlisten: (() => void) | null = null;
  let fallbackUnlisten: (() => void) | null = null;
  let disposed = false;

  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    if (disposed) return;
    getCurrentWindow().onThemeChanged(() => {
      onChange();
    }).then(unlisten => {
      if (disposed) { unlisten(); return; }
      tauriUnlisten = unlisten;
    });
  }).catch(() => {
    // Tauri API not available (web mode) — fall back to matchMedia
    if (disposed) return;
    fallbackUnlisten = watchSystemTheme(onChange);
  });

  return () => {
    disposed = true;
    tauriUnlisten?.();
    fallbackUnlisten?.();
  };
}

async function syncStatusBarTheme(theme: ResolvedTheme): Promise<void> {
  void theme;
}
