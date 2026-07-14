import { isTauri } from '$lib/platform';

export function openUrl(url: string): void {
  if (isTauri) {
    import('@tauri-apps/plugin-opener').then(({ openUrl: tauriOpen }) => {
      tauriOpen(url);
    });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
