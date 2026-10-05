import { toWellFormedText } from '@futo-notes/editor';

import { isTauri } from './index';

export function openExternalUrl(url: string): void {
  if (isTauri) {
    // The opener rejects any scheme outside its allowlist; an unhandled
    // rejection would be filed as a crash report.
    import('@tauri-apps/plugin-opener')
      .then(({ openUrl: tauriOpen }) => tauriOpen(toWellFormedText(url))) // RC-95
      .catch((error: unknown) => console.warn('Failed to open external URL:', error));
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
