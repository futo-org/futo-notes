import { toWellFormedText } from '@futo-notes/editor';

import { isTauri } from './index';

let opened: { count: number; url: string } | null = null;

/** What the app last handed the OS to open, and how many it has: the agent's `state.opened`,
 *  so a receipt says which page a button opened without reading the browser. */
export function lastOpenedUrl(): { count: number; url: string } | null {
  return opened;
}

export function openExternalUrl(url: string): void {
  opened = { count: (opened?.count ?? 0) + 1, url };
  if (isTauri) {
    const link = toWellFormedText(url); // RC-95
    // A dev build opens it behind the developer's window, in their chosen browser
    // (apps/tauri/src-tauri/src/dev_open_url.rs): an agent pressing "Buy a license"
    // must not pull a browser over what they are doing.
    const opened = import.meta.env.DEV
      ? import('./tauri/invoke').then(({ invoke }) => invoke('dev_open_url', { url: link }))
      : import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(link));
    // The opener rejects any scheme outside its allowlist; an unhandled
    // rejection would be filed as a crash report.
    opened.catch((error: unknown) => console.warn('Failed to open external URL:', error));
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
