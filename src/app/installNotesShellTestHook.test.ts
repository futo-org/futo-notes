// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installNotesShellTestHook } from './installNotesShellTestHook';

interface TestHookWindow extends Window {
  __notesShellTest?: {
    replaceEditorContent: (content: string) => string;
    typeInEditor: (text: string) => string;
  };
}

describe('installNotesShellTestHook', () => {
  let view: EditorView | null = null;
  let removeHook: (() => void) | null = null;

  afterEach(() => {
    removeHook?.();
    removeHook = null;
    view?.destroy();
    view = null;
  });

  it('replaces the complete editor document through a CodeMirror transaction', () => {
    view = new EditorView({ doc: 'probe mutation', parent: document.body });
    const flushSave = vi.fn(async () => {});
    removeHook = installNotesShellTestHook({
      handleSyncComplete: async () => {},
      handleLiveState: () => {},
      handleFileChange: async () => {},
      seedOpenNote: () => {},
      flushSave,
      getEditorView: () => view,
      focusEditor: () => {},
      setEditorFocused: async () => {},
      isEditorFocused: () => false,
      getState: () => ({
        originalId: 'probe',
        title: 'probe',
        toastMessage: '',
        hash: '#/note/probe',
        editorContent: view?.state.doc.toString() ?? '',
        savePending: false,
      }),
    });

    const hook = (window as TestHookWindow).__notesShellTest;
    expect(hook?.replaceEditorContent('original content')).toBe('original content');
    expect(view.state.doc.toString()).toBe('original content');
    expect(view.state.selection.main.head).toBe('original content'.length);
    expect(flushSave).not.toHaveBeenCalled();
  });

  it('types at the current selection through a CodeMirror transaction', () => {
    view = new EditorView({ doc: 'before after', parent: document.body });
    view.dispatch({ selection: { anchor: 6 } });
    removeHook = installNotesShellTestHook({
      handleSyncComplete: async () => {},
      handleLiveState: () => {},
      handleFileChange: async () => {},
      seedOpenNote: () => {},
      flushSave: async () => {},
      getEditorView: () => view,
      focusEditor: () => {},
      setEditorFocused: async () => {},
      isEditorFocused: () => false,
      getState: () => ({
        originalId: null,
        title: '',
        toastMessage: '',
        hash: '#/',
        editorContent: '',
        savePending: false,
      }),
    });

    const hook = (window as TestHookWindow).__notesShellTest;
    expect(hook?.typeInEditor('middle ')).toBe('beforemiddle  after');
    expect(view.state.selection.main.head).toBe(13);
  });
});
