import type { EditorView } from '@codemirror/view';

import type { SyncSummary } from '$features/sync/syncServiceE2ee';

import { testHooksEnabled } from './testHooksEnabled';

interface NotesShellTestState {
  originalId: string | null;
  title: string;
  toastMessage: string;
  hash: string;
  editorContent: string;
  savePending: boolean;
}

interface NotesShellTestHookOptions {
  handleSyncComplete: (summary: SyncSummary) => Promise<void>;
  handleLiveState: (payload: { live: boolean; status: string; message?: string }) => void;
  handleFileChange: (event: {
    type: 'add' | 'change' | 'unlink';
    filename: string;
  }) => Promise<void>;
  seedOpenNote: (id: string, body: string) => void;
  flushSave: () => Promise<void>;
  getEditorView: () => EditorView | null;
  focusEditor: () => void;
  setEditorFocused: (focused: boolean) => Promise<void>;
  isEditorFocused: () => boolean;
  getState: () => NotesShellTestState;
}

interface NotesShellTestHook {
  handleSyncComplete: NotesShellTestHookOptions['handleSyncComplete'];
  handleLiveState: NotesShellTestHookOptions['handleLiveState'];
  handleFileChange: NotesShellTestHookOptions['handleFileChange'];
  seedOpenNote: NotesShellTestHookOptions['seedOpenNote'];
  flushSave: NotesShellTestHookOptions['flushSave'];
  typeInEditor: (text: string) => string;
  setEditorFocused: NotesShellTestHookOptions['setEditorFocused'];
  isEditorFocused: NotesShellTestHookOptions['isEditorFocused'];
  replaceEditorContent: (content: string) => string;
  getState: NotesShellTestHookOptions['getState'];
}

type TestHookWindow = typeof window & { __notesShellTest?: NotesShellTestHook };

/**
 * Expose the shell's seams on `window.__notesShellTest` for the E2E and
 * cross-platform harnesses — in a dev or opted-in build only. Gated for the same
 * reason as `installDevelopmentHooks`, and more urgently: `setEditorFocused`
 * calls production sync code, so in a shipped build this would be a reachable
 * behavior override, not just an observation point.
 */
export function installNotesShellTestHook(options: NotesShellTestHookOptions): () => void {
  if (!testHooksEnabled()) return () => {};
  const testWindow = window as TestHookWindow;
  testWindow.__notesShellTest = {
    handleSyncComplete: options.handleSyncComplete,
    handleLiveState: options.handleLiveState,
    handleFileChange: options.handleFileChange,
    seedOpenNote: (id, body) => {
      options.seedOpenNote(id, body);
      queueMicrotask(options.focusEditor);
    },
    flushSave: options.flushSave,
    typeInEditor: (text) => typeInEditor(options.getEditorView(), text),
    setEditorFocused: options.setEditorFocused,
    isEditorFocused: options.isEditorFocused,
    replaceEditorContent: (content) => replaceEditorContent(options.getEditorView(), content),
    getState: options.getState,
  };
  return () => {
    delete testWindow.__notesShellTest;
  };
}

function typeInEditor(view: EditorView | null, text: string): string {
  if (!view) throw new Error('editor view not ready');
  view.focus();
  const { main } = view.state.selection;
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: text },
    selection: { anchor: main.from + text.length },
    scrollIntoView: true,
    userEvent: 'input.type',
  });
  return view.state.doc.toString();
}

function replaceEditorContent(view: EditorView | null, content: string): string {
  if (!view) throw new Error('editor view not ready');
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    selection: { anchor: content.length },
    userEvent: 'input',
  });
  return view.state.doc.toString();
}
