import { isTauri } from './index';

export function openExternalUrl(url: string): void {
  if (isTauri) {
    void import('@tauri-apps/plugin-opener').then(({ openUrl: tauriOpen }) => {
      void tauriOpen(url);
    });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
