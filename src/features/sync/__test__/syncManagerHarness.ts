// Shared setup for the syncManager unit tests: the module mocks, the mock state
// they write into, the session/manager factories, and the per-test reset. A
// test file imports this BEFORE the modules under test so its mocks are in place.
import { vi } from 'vitest';

export let autoSyncCallbacks: import('../autoSync').AutoSyncCallbacks | null = null;
// vitest forbids exporting a hoisted variable, so the mock factories below read
// this private object and the tests get the same two objects through the exports.
const hoisted = vi.hoisted(() => ({
  tauriEventMocks: {
    listeners: new Map<string, (event: { payload: unknown }) => void>(),
  },
  openNoteMocks: {
    classifyOpenNote: vi.fn(),
  },
}));
export const tauriEventMocks = hoisted.tauriEventMocks;
export const openNoteMocks = hoisted.openNoteMocks;
vi.mock('../autoSync', () => ({
  startAutoSync: (callbacks: import('../autoSync').AutoSyncCallbacks) => {
    autoSyncCallbacks = callbacks;
  },
  stopAutoSync: vi.fn(),
  notifySaved: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
    hoisted.tauriEventMocks.listeners.set(event, listener);
    return () => hoisted.tauriEventMocks.listeners.delete(event);
  }),
}));
vi.mock('../syncServiceE2ee', () => ({
  classifyOpenNote: hoisted.openNoteMocks.classifyOpenNote,
}));
vi.mock('$lib/platform', () => ({ hasFileSystem: true, isTauri: true }));
vi.mock('$shared/state/appState', () => ({ updateAppState: vi.fn(async () => {}) }));
const rescanLocalNotes = vi.hoisted(() => vi.fn(async () => {}));
const refreshNotesAfterSync = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/localNoteStore', () => ({
  getLocalNoteStoreSync: vi.fn(() => ({ rescan: rescanLocalNotes })),
}));
vi.mock('$features/notes/notes.svelte', () => ({
  updateNote: vi.fn(async (id: string) => ({ id, mtime: 0, disposition: 'wrote' })),
  noteExists: vi.fn(async () => false),
  getNoteById: vi.fn(() => undefined),
  handleExternalFileChange: vi.fn(async () => {}),
  refreshNotesAfterSync,
  refreshNotesFromStorage: vi.fn(async () => {}),
}));

import { updateAppState } from '$shared/state/appState';
import { noteExists, refreshNotesFromStorage, updateNote } from '$features/notes/notes.svelte';
import {
  createNoteSession,
  type NoteSession,
  type NoteSessionDeps,
} from '$features/notes/noteSession.svelte';
import type { ToastMessage } from '$shared/notifications/toastBus.svelte';
import { createSyncManager, type SyncManagerDeps } from '../syncManager.svelte';
import type { SyncSummary } from '../syncServiceE2ee';

export const emptySummary: SyncSummary = {
  uploaded: 0,
  downloaded: 0,
  deleted: 0,
  conflicts: 0,
  localWritesApplied: 0,
  failures: [],
  failureMessage: null,
  updatedIds: [],
  deletedIds: [],
  renamed: [],
  peerUpdatedIds: [],
  peerDeletedIds: [],
  writeRefusal: null,
};

type SessionState = {
  id: string | null;
  content: string | undefined;
  savedContent: string;
  dirty: boolean;
  focused: boolean;
  composing: boolean;
  savePending: boolean;
  editVersion: number;
  lastEditTime: number;
  title: string;
};

export function makeSession(overrides: Partial<SessionState> = {}) {
  const state: SessionState = {
    id: null,
    content: undefined,
    savedContent: '',
    dirty: false,
    focused: false,
    composing: false,
    savePending: false,
    editVersion: 0,
    lastEditTime: 0,
    title: overrides.id ?? '',
    ...overrides,
  };
  if (overrides.savedContent === undefined) state.savedContent = state.content ?? '';
  const applyExternalContent = vi.fn((content: string) => {
    state.content = content;
    state.savedContent = content;
  });
  const rebaseSavedContent = vi.fn((content: string) => {
    state.savedContent = content;
  });
  const applyRemoteRename = vi.fn((id: string) => {
    state.id = id;
  });
  const cancelAndClear = vi.fn(() => {
    state.id = null;
  });
  const session = {
    get title() {
      return state.title;
    },
    get originalId() {
      return state.id;
    },
    get editorContent() {
      return state.content;
    },
    get savedContent() {
      return state.savedContent;
    },
    get dirty() {
      return state.dirty;
    },
    get editorFocused() {
      return state.focused;
    },
    get composing() {
      return state.composing;
    },
    get savePending() {
      return state.savePending;
    },
    get editVersion() {
      return state.editVersion;
    },
    get lastEditTime() {
      return state.lastEditTime;
    },
    flushSave: vi.fn(async () => {}),
    resumeDraftPersistence: vi.fn(),
    applyExternalContent,
    rebaseSavedContent,
    applyRemoteRename,
    cancelAndClear,
  } as unknown as NoteSession;
  return {
    state,
    session,
    applyExternalContent,
    rebaseSavedContent,
    applyRemoteRename,
    cancelAndClear,
  };
}

export function makeManager(
  sessionBundle = makeSession(),
  overrides: Partial<Omit<SyncManagerDeps, 'session'>> = {},
) {
  const toasts: ToastMessage[] = [];
  const onRename = vi.fn();
  const pruneTabsForDeletedIds = vi.fn();
  const manager = createSyncManager({
    session: sessionBundle.session,
    showToast: (message) => toasts.push(message),
    onRename,
    pruneTabsForDeletedIds,
    ...overrides,
  });
  return { manager, toasts, onRename, pruneTabsForDeletedIds, ...sessionBundle };
}

export function makeLiveNoteSession(id: string, body: string) {
  let editorContent = body;
  const setEditorContent = vi.fn((content: string) => {
    editorContent = content;
  });
  const forgetEditorNote = vi.fn();
  const openEditorNote = vi.fn((_noteId: string | null, content: string) => {
    editorContent = content;
  });
  const deps = {
    getEditorContent: () => editorContent,
    setEditorContent,
    openEditorNote,
    forgetEditorNote,
    focusEditor: vi.fn(),
    isEditorFocused: () => false,
    isComposing: () => false,
    getNotes: () => [],
    getNoteBody: () => undefined,
    getTitleTextarea: () => undefined,
    getNoteId: () => id,
    setPrevNoteId: vi.fn(),
    onNoteRenamed: vi.fn(),
    reconcileOpenNote: vi.fn(async () => false),
    navigate: vi.fn(),
  } satisfies NoteSessionDeps;
  const session = createNoteSession(deps);
  session.seedOpenNote(id, body);
  setEditorContent.mockClear();

  return {
    session,
    setEditorContent,
    getEditorContent: () => editorContent,
    editContent: (content: string) => {
      editorContent = content;
      session.debouncedSave(content);
    },
  };
}

/** A manager over a real note session whose toasts and tab callbacks are not asserted. */
export function managerFor(session: NoteSession) {
  return createSyncManager({
    session,
    showToast: vi.fn(),
    onRename: vi.fn(),
    pruneTabsForDeletedIds: vi.fn(),
  });
}

export function controlledPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export async function yieldMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

export function resetSyncManagerHarness(): void {
  autoSyncCallbacks = null;
  tauriEventMocks.listeners.clear();
  vi.mocked(noteExists).mockReset();
  vi.mocked(noteExists).mockResolvedValue(false);
  vi.mocked(refreshNotesFromStorage).mockClear();
  vi.mocked(updateNote).mockReset();
  vi.mocked(updateNote).mockImplementation(async (id: string) => ({
    id,
    mtime: 0,
    disposition: 'wrote',
  }));
  rescanLocalNotes.mockClear();
  refreshNotesAfterSync.mockClear();
  vi.mocked(updateAppState).mockClear();
  openNoteMocks.classifyOpenNote.mockReset();
  openNoteMocks.classifyOpenNote.mockResolvedValue({ kind: 'leave' });
  vi.useFakeTimers();
}
