import { isTauri } from '$lib/platform';

/**
 * Open a URL in the system's default browser.
 * Uses Tauri's opener plugin when running in Tauri (desktop/mobile),
 * falls back to window.open for web.
 */
export function openUrl(url: string): void {
  if (isTauri) {
    import('@tauri-apps/plugin-opener').then(({ openUrl: tauriOpen }) => {
      tauriOpen(url);
    });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
