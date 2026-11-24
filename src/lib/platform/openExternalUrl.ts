import { toWellFormedText } from '@futo-notes/editor';

import { isTauri } from './index';

/** How a link leaves the app: `front` the system's own way (the default browser or handler,
 *  brought forward), `behind` in the default browser without bringing it forward
 *  (apps/tauri/src-tauri/src/open_url_behind.rs), `devBehind` the dev build's way, behind the
 *  developer's window in the browser they chose (dev_open_url.rs). */
type OpenedRoute = 'front' | 'behind' | 'devBehind';

let opened: { count: number; url: string } | null = null;

/** What the app last handed the OS to open, and how many it has: the agent's `state.opened`,
 *  so a receipt says which page a button opened without reading the browser. */
export function lastOpenedUrl(): { count: number; url: string } | null {
  return opened;
}

function open(url: string, route: OpenedRoute): void {
  opened = { count: (opened?.count ?? 0) + 1, url };
  if (!isTauri) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const link = toWellFormedText(url); // RC-95
  const sent =
    route === 'front'
      ? import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(link))
      : import('./tauri/invoke').then(({ invoke }) =>
          route === 'behind'
            ? invoke('open_url_behind', { url: link })
            : invoke('dev_open_url', { url: link }),
        );
  // The opener rejects any scheme outside its allowlist; an unhandled
  // rejection would be filed as a crash report.
  sent.catch((error: unknown) => console.warn('Failed to open external URL:', error));
}

/** Open a page in front. A dev build opens it behind the developer's window instead: an agent
 *  pressing "Buy a license" must not pull a browser over what they are doing. */
export function openExternalUrl(url: string): void {
  open(url, import.meta.env.DEV ? 'devBehind' : 'front');
}

/** A link pressed in a note: in front, or `behind` the window for the gesture that asks it. A
 *  dev build opens every one the dev way. */
export function openPressedLink(url: string, behind: boolean): void {
  if (import.meta.env.DEV) {
    open(url, 'devBehind');
    return;
  }
  open(url, behind ? 'behind' : 'front');
}
