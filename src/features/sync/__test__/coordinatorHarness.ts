// Shared setup for the external-change coordinator unit tests: the module mocks,
// the session and coordinator factories, and the per-test reset. A test file
// imports this BEFORE the modules under test so its mocks are in place.
import { vi } from 'vitest';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { createWriteSuppressor } from '$lib/platform/writeSuppression';
import type { OpenNoteDispositionOutput, OpenNoteRequestInput } from '../syncContract.generated';
import { createExternalChangeCoordinator } from '../createExternalChangeCoordinator';

// vitest forbids exporting a hoisted variable, so the mock factories below read
// this private object and the tests get the same two objects through the exports.
const hoisted = vi.hoisted(() => ({
  noteMocks: {
    handleExternalFileChange: vi.fn(async () => {}),
    refreshNotesFromStorage: vi.fn(async () => {}),
    // The real note session (below) persists through these.
    updateNote: vi.fn(),
    getNoteById: vi.fn(),
    readNote: vi.fn(async () => ''),
    _applyLocalMutation: vi.fn(),
    recordSaveIdentityChange: vi.fn(),
  },
  syncMocks: {
    classifyOpenNote: vi.fn<(facts: OpenNoteRequestInput) => Promise<OpenNoteDispositionOutput>>(),
  },
}));
export const noteMocks = hoisted.noteMocks;
export const syncMocks = hoisted.syncMocks;

vi.mock('$features/notes/notes.svelte', () => hoisted.noteMocks);
vi.mock('$lib/platform', () => ({ hasFileSystem: true }));
vi.mock('$features/sync/autoSync', () => ({ notifySaved: vi.fn() }));
vi.mock('$shared/notifications/toastBus.svelte', () => ({ showGlobalToast: vi.fn() }));
vi.mock('../syncServiceE2ee', () => ({
  classifyOpenNote: hoisted.syncMocks.classifyOpenNote,
}));

export interface SessionState {
  composing: boolean;
  dirty: boolean;
  editVersion: number;
  editorContent: string;
  editorFocused: boolean;
  originalId: string | null;
  savedContent: string;
  savePending: boolean;
  title: string;
}

export function makeSession(overrides: Partial<SessionState> = {}) {
  const state: SessionState = {
    composing: false,
    dirty: false,
    editVersion: 0,
    editorContent: 'base',
    editorFocused: false,
    originalId: 'active',
    savedContent: 'base',
    savePending: false,
    title: 'active',
    ...overrides,
  };
  const applyExternalContent = vi.fn((content: string) => {
    state.editorContent = content;
    state.savedContent = content;
  });
  const rebaseSavedContent = vi.fn((content: string) => {
    state.savedContent = content;
  });
  const applyRemoteRename = vi.fn((id: string, title: string) => {
    state.originalId = id;
    state.title = title;
  });
  const cancelAndClear = vi.fn(() => {
    state.originalId = null;
  });
  const session = {
    get title() {
      return state.title;
    },
    content: 'base',
    get originalId() {
      return state.originalId;
    },
    titleWarning: '',
    loading: false,
    get editVersion() {
      return state.editVersion;
    },
    lastEditTime: 0,
    get savePending() {
      return state.savePending;
    },
    get savedContent() {
      return state.savedContent;
    },
    get dirty() {
      return state.dirty;
    },
    get editorContent() {
      return state.editorContent;
    },
    get editorFocused() {
      return state.editorFocused;
    },
    get composing() {
      return state.composing;
    },
    debouncedSave: vi.fn(),
    resumeDraftPersistence: vi.fn(),
    flushSave: vi.fn(async () => {}),
    runWithSaveLock: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
    loadNote: vi.fn(async () => {}),
    handleTitleInput: vi.fn(),
    handleTitleKeydown: vi.fn(),
    handleTitleFocus: vi.fn(),
    handleTitlePointerDown: vi.fn(),
    seedOpenNote: vi.fn(),
    cancelAndClear,
    applyExternalContent,
    rebaseSavedContent,
    applyRemoteRename,
  } satisfies NoteSession;
  return {
    applyExternalContent,
    applyRemoteRename,
    cancelAndClear,
    rebaseSavedContent,
    session,
    state,
  };
}

export function makeCoordinator(
  sessionBundle = makeSession(),
  writeSuppressor = createWriteSuppressor(),
) {
  const notifySaved = vi.fn();
  const showToast = vi.fn();
  const followRename = vi.fn((fromId: string, toId: string) => {
    if (sessionBundle.state.originalId === fromId) {
      sessionBundle.state.originalId = toId;
    }
  });
  const coordinator = createExternalChangeCoordinator({
    followRename,
    session: sessionBundle.session,
    notifySaved,
    showToast,
    writeSuppressor,
  });
  return {
    coordinator,
    followRename,
    notifySaved,
    showToast,
    ...sessionBundle,
  };
}

export function controlledPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function resetCoordinatorMocks(): void {
  vi.clearAllMocks();
  syncMocks.classifyOpenNote.mockResolvedValue({ kind: 'leave' });
}
