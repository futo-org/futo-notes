import type { EditorView } from '@codemirror/view';

import type { SyncSummary } from '$features/sync/syncServiceE2ee';

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
  getState: () => NotesShellTestState;
}

interface NotesShellTestHook {
  handleSyncComplete: NotesShellTestHookOptions['handleSyncComplete'];
  handleLiveState: NotesShellTestHookOptions['handleLiveState'];
  handleFileChange: NotesShellTestHookOptions['handleFileChange'];
  seedOpenNote: NotesShellTestHookOptions['seedOpenNote'];
  flushSave: NotesShellTestHookOptions['flushSave'];
  typeInEditor: (text: string) => string;
  getState: NotesShellTestHookOptions['getState'];
}

type TestHookWindow = typeof window & { __notesShellTest?: NotesShellTestHook };

export function installNotesShellTestHook(options: NotesShellTestHookOptions): () => void {
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
