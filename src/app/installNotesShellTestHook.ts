import type { SyncSummary } from '$features/sync/syncServiceE2ee';
import {
  clearNoteSwitchTimelines,
  getNoteSwitchTimelines,
  type NoteSwitchTimeline,
} from '$shared/perf/noteSwitchTimeline';

import { noteEditIntent } from '$shared/lifecycle/editIntent';
import { TEST_HOOKS_ENABLED } from './testHooksEnabled';

/**
 * The slice of the editor the harnesses drive. Deliberately narrower than
 * `EditorApi`: a hook that could reach the whole editor would grow assertions
 * about the engine rather than about the product.
 */
interface TestEditorTarget {
  focus: () => void;
  insertMarkdown: (text: string) => void;
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
  seedOpenNote: (id: string) => void;
  flushSave: () => Promise<void>;
  getEditor: () => TestEditorTarget | null;
  focusEditor: () => void;
  setEditorFocused: (focused: boolean) => Promise<void>;
  isEditorFocused: () => boolean;
  holdSaves: (held: boolean) => Promise<void>;
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
  /** While held, the editor's host declines every write of the open note (its timer,
   * a checkpoint or flush; a rename or close fails) — a dirty draft that cannot reach
   * disk, held across a peer edit or an external write — and the editor reads as
   * settled (`savePending` false). Releasing writes nothing; the next flush does. The
   * host holds only in a debug build (editor_host `editor_hold_saves`). */
  holdSaves: NotesShellTestHookOptions['holdSaves'];
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
  if (!TEST_HOOKS_ENABLED) return () => {};
  const testWindow = window as TestHookWindow;
  testWindow.__notesShellTest = {
    handleSyncComplete: options.handleSyncComplete,
    handleLiveState: options.handleLiveState,
    handleFileChange: options.handleFileChange,
    seedOpenNote: (id) => {
      options.seedOpenNote(id);
      queueMicrotask(options.focusEditor);
    },
    flushSave: options.flushSave,
    typeInEditor: (text) => typeInEditor(options.getEditor(), text),
    setEditorFocused: options.setEditorFocused,
    isEditorFocused: options.isEditorFocused,
    holdSaves: options.holdSaves,
    getState: options.getState,
    noteSwitchTimelines: getNoteSwitchTimelines,
    clearNoteSwitchTimelines,
  };
  return () => {
    delete testWindow.__notesShellTest;
  };
}

/** Insert `text` at the caret, replacing the selection, and report the note as it now stands. */
function typeInEditor(editor: TestEditorTarget | null, text: string): string {
  if (!editor) throw new Error('editor not ready');
  editor.focus();
  // Stands in for typing, which would fire `beforeinput`; announce it the same way.
  noteEditIntent();
  editor.insertMarkdown(text);
  return editor.getContent() ?? '';
}
