// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const readRecentNoteIds = vi.hoisted(() => vi.fn<(limit: number) => Promise<string[]>>());
vi.mock('./notes.svelte', () => ({ readRecentNoteIds }));

import ForYouPage from './ForYouPage.svelte';

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = '';
});

// Crash #1830: with the vault folder gone, every note command rejects, and this
// read had no handler, so the crash reporter filed the expected state as a crash.
it('a failed recent-notes read is handled and shows no empty-vault heading', async () => {
  readRecentNoteIds.mockRejectedValue("Can't find your vault folder at /gone.");
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const target = document.body.appendChild(document.createElement('div'));
    app = mount(ForYouPage, { target, props: { notes: [], onnavigate: () => {} } });
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readRecentNoteIds).toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    expect(target.querySelector('.for-you-empty')).toBeNull();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});
