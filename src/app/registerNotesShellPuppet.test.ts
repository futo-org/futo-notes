// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { setFolderOpen } from '$features/folders/folderExpansion.svelte';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

import { puppetProviders } from './puppet/puppetRegistry';
import { registerNotesShellPuppet } from './registerNotesShellPuppet';

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('$features/notes/notes.svelte', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readNote: async (id: string) => disk.get(id) ?? '',
}));

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

it('file: only a body the save did not land is unsaved, and only an id `notes` lists is read', async () => {
  const session = {
    originalId: 'work/retro',
    title: 'Standup',
    savePending: false,
    // A title the save refused leaves the session dirty; its body saved all the same.
    dirty: true,
    editorContent: 'lease',
    content: 'lease',
    savedContent: 'lease',
    flushSave: async () => {},
  };
  disk.set('work/retro', 'lease').set('work/empty', '');
  const notes = [{ id: 'work/retro' }, { id: 'work/empty' }];
  unregister = registerNotesShellPuppet({
    session,
    sync: { live: false, syncOffline: false, syncStatusMessage: '', syncErrorMessage: '' },
    tabTransition: { settled: () => undefined },
    notes: () => notes,
    settingsOpen: () => false,
    searchOpen: () => false,
  } as unknown as Parameters<typeof registerNotesShellPuppet>[0]);
  const shell = puppetProviders.shell!;

  expect(await shell.saveOpenNote!()).toEqual([]);
  // Cleared inside the editor's change debounce: the save will not write a blank over
  // the body, so the disk still holds it.
  session.editorContent = '';
  expect(await shell.saveOpenNote!()).toEqual(['work/retro']);
  session.editorContent = 'lease signed';
  session.flushSave = async () => {
    throw new Error('disk full');
  };
  expect(await shell.saveOpenNote!()).toEqual(['work/retro']);

  expect(await shell.readNote!('work/retro')).toBe('lease');
  expect(await shell.readNote!('work/empty')).toBe('');
  expect(await shell.readNote!('Work/Retro')).toBeNull();
  expect(await shell.readNote!('work/gone')).toBeNull();
});
