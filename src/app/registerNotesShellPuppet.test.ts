// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';

import { setFolderOpen } from '$features/folders/folderExpansion.svelte';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

import { puppetProviders } from './puppet/puppetRegistry';
import { registerNotesShellPuppet } from './registerNotesShellPuppet';

let unregister = () => {};

afterEach(() => {
  unregister();
  setFolderOpen('work', false);
});

it('state names every tab, home included, says which is active, and which folders are open', () => {
  unregister = registerNotesShellPuppet({
    session: { originalId: null, title: '', savePending: false },
    sync: { live: false, syncOffline: false, syncStatusMessage: '', syncErrorMessage: '' },
    tabTransition: { settled: () => undefined },
    notes: () => [],
    settingsOpen: () => false,
    searchOpen: () => false,
  } as unknown as Parameters<typeof registerNotesShellPuppet>[0]);
  tabsStore.openNote('work/standup', 'foreground');
  setFolderOpen('work', true);

  expect(puppetProviders.shell?.state()).toMatchObject({
    tabs: ['home', 'work/standup'],
    activeTab: 1,
    openFolders: ['work'],
  });
});
