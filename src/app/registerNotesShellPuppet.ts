import { listVaultFolders } from '$features/folders/emptyFolders.svelte';
import { openFolderPaths } from '$features/folders/folderExpansion.svelte';
import { getAllNotes, readNote, search as searchVault } from '$features/notes/notes.svelte';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { isSyncing } from '$features/sync/autoSync';
import type { SyncManager } from '$features/sync/syncManager.svelte';
import { isE2eeConfigured } from '$features/sync/syncServiceE2ee';
import { tabsStore } from '$features/tabs/tabsStore.svelte';
import { currentToastMessage } from '$shared/notifications/toastBus.svelte';
import { getAppState } from '$shared/state/appState';

import type { createTabNoteTransition } from './createTabNoteTransition';
import { registerPuppetShell } from './puppet/puppetRegistry';
import { storedSettings } from './puppet/puppetStoredSettings';

/** What NotesShell lends the puppet: its own state, read live on every call. */
interface NotesShellPuppetView {
  session: NoteSession;
  sync: SyncManager;
  tabTransition: ReturnType<typeof createTabNoteTransition>;
  notes: () => ReturnType<typeof getAllNotes>;
  settingsOpen: () => boolean;
  searchOpen: () => boolean;
}

// What the desktop shell tells `futo-puppet`: which screen this is and what it
// believes. Same gate as the test hook; a no-op in a shipped build.
export function registerNotesShellPuppet(view: NotesShellPuppetView): () => void {
  const { session, sync, tabTransition } = view;
  return registerPuppetShell({
    screen: () => (tabsStore.activeNoteId === null ? 'home' : `editor:${tabsStore.activeNoteId}`),
    state: () => ({
      note: session.originalId === null ? null : { id: session.originalId, title: session.title },
      tabs: tabsStore.tabs.map((tab) => tab.noteId ?? 'home'),
      activeTab: tabsStore.tabs.findIndex((tab) => tab.id === tabsStore.activeTabId),
      // The folders the sidebar tree draws open: a row is drawn when every folder above it is.
      openFolders: openFolderPaths(),
      settingsOpen: view.settingsOpen(),
      searchOpen: view.searchOpen(),
      toast: currentToastMessage(),
      // As stored, whole: a receipt shows any setting an action changes, picked or not.
      settings: storedSettings(getAppState()),
      sync: {
        connected: isE2eeConfigured(),
        live: sync.live,
        offline: sync.syncOffline,
        status: sync.syncStatusMessage,
        lastError: sync.syncErrorMessage || null,
      },
      // Work still in flight: an action whose receipt shows this has not finished yet.
      pending: {
        unsaved: session.savePending && session.originalId !== null ? [session.originalId] : [],
        sync: isSyncing(),
      },
    }),
    // The vault itself, not the tree: a folder keeps existing with no row once
    // its last note leaves, and a collapsed folder's notes are absent from
    // every DOM query. Folders are the ancestors of the note ids plus the
    // empty ones the store reports.
    vault: () => {
      const notes = view.notes();
      const noteIds = notes.map((note) => note.id);
      const modified = Object.fromEntries(notes.map((note) => [note.id, note.modificationTime]));
      return { notes: noteIds, folders: listVaultFolders(notes), modified };
    },
    search: async (query, limit) => (await searchVault(query, limit)).map((note) => note.id),
    // `file` reads the body, so only a body the save did not land counts: a title
    // the save refused still saves the body under the note's name. Not the save's
    // own test: a note cleared inside the editor's change debounce reads as a lost
    // note, which the save will not write, and its disk still holds the old body.
    saveOpenNote: async () => {
      await session.flushSave().catch(() => {});
      const { originalId, editorContent } = session;
      return originalId !== null &&
        editorContent !== undefined &&
        editorContent !== session.savedContent
        ? [originalId]
        : [];
    },
    // Only an id `notes` lists: a case-insensitive disk reads "Work/Retro" as work/retro.
    // ponytail: a note deleted between this check and the read prints as empty, not 404.
    readNote: async (noteId) =>
      view.notes().some((note) => note.id === noteId) ? readNote(noteId) : null,
    // A note switch saves a dirty note before loading the next: until the new note
    // is in the editor, the receipt of whatever verb asked for it waits, and a save
    // that fails keeps the old tab, which the receipt must say.
    settled: () =>
      tabsStore.hydrated
        ? tabTransition
            .settled()
            ?.then((failure) =>
              failure === undefined
                ? undefined
                : `the note did not switch: saving ${session.originalId ?? 'the open note'} failed (${failure instanceof Error ? failure.message : String(failure)}), so its tab stays open`,
            )
        : undefined,
  });
}
