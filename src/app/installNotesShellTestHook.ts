import type { SyncSummary } from '$features/sync/syncServiceE2ee';
import {
  clearNoteSwitchTimelines,
  getNoteSwitchTimelines,
  type NoteSwitchTimeline,
} from '$shared/perf/noteSwitchTimeline';

import { testHooksEnabled } from './testHooksEnabled';

/**
 * The slice of the editor the harnesses drive. Deliberately narrower than
 * `EditorApi`: a hook that could reach the whole editor would grow assertions
 * about the engine rather than about the product.
 */
interface TestEditorTarget {
  focus: () => void;
  insertMarkdown: (text: string) => void;
  applyEdit: (markdown: string) => void;
  getContent: () => string | undefined;
}

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
  getEditor: () => TestEditorTarget | null;
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
  noteSwitchTimelines: () => readonly NoteSwitchTimeline[];
  clearNoteSwitchTimelines: () => void;
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
    typeInEditor: (text) => typeInEditor(options.getEditor(), text),
    setEditorFocused: options.setEditorFocused,
    isEditorFocused: options.isEditorFocused,
    replaceEditorContent: (content) => replaceEditorContent(options.getEditor(), content),
    getState: options.getState,
    noteSwitchTimelines: getNoteSwitchTimelines,
    clearNoteSwitchTimelines,
  };
  return () => {
    delete testWindow.__notesShellTest;
  };
}

/**
 * Insert markdown at the caret, replacing the selection, and report the note
 * as it now stands.
 *
 * `text` is parsed as markdown rather than dropped in as literal characters:
 * the editor is a WYSIWYG surface, so a harness that "typed" `# Heading` into
 * it as text would produce an escaped `\# Heading` in the file and assert on a
 * document no user could ever have made.
 */
function typeInEditor(editor: TestEditorTarget | null, text: string): string {
  if (!editor) throw new Error('editor not ready');
  editor.focus();
  editor.insertMarkdown(text);
  return editor.getContent() ?? '';
}

function replaceEditorContent(editor: TestEditorTarget | null, content: string): string {
  if (!editor) throw new Error('editor not ready');
  editor.applyEdit(content);
  return editor.getContent() ?? '';
}
