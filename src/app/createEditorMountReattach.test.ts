import { describe, expect, it, vi } from 'vitest';

import { createEditorMountReattach } from './createEditorMountReattach';

interface ShellState {
  /** The mount the shell's binding reaches. */
  boundMount: string | null;
  noteHeld: boolean;
}

function shell(state: ShellState): {
  state: ShellState;
  reattach: ReturnType<typeof createEditorMountReattach<string>>;
  reattachEditor: ReturnType<typeof vi.fn>;
} {
  const reattachEditor = vi.fn();
  const reattach = createEditorMountReattach<string>({
    isEditorBound: (mount) => state.boundMount === mount,
    sessionHoldsNote: () => state.noteHeld,
    reattachEditor,
  });
  return { state, reattach, reattachEditor };
}

describe('createEditorMountReattach', () => {
  it('hands the open note to an editor remounted behind the same binding', () => {
    // A dev hot reload of the editor: the bound object stays, and reaches the new mount
    // before that mount is reported. No binding change follows.
    const { state, reattach, reattachEditor } = shell({ boundMount: 'first', noteHeld: false });
    reattach.editorMounted('first');
    state.noteHeld = true;

    state.boundMount = 'second';
    reattach.editorMounted('second');

    expect(reattachEditor).toHaveBeenCalledTimes(1);
  });

  it('waits for the binding while it still names the editor this mount replaced', () => {
    // A dev hot reload of the editor's parent: the old editor is gone, and still bound.
    const { state, reattach, reattachEditor } = shell({ boundMount: 'first', noteHeld: true });
    reattach.editorMounted('second');
    expect(reattachEditor).not.toHaveBeenCalled();

    state.boundMount = 'second';
    reattach.editorBound();
    reattach.editorBound();

    expect(reattachEditor).toHaveBeenCalledTimes(1);
  });

  it('hands a note that loaded before the first editor was bound, once', () => {
    const { state, reattach, reattachEditor } = shell({ boundMount: null, noteHeld: true });
    reattach.editorMounted('first');
    expect(reattachEditor).not.toHaveBeenCalled();

    state.boundMount = 'first';
    reattach.editorBound();
    reattach.editorBound();

    expect(reattachEditor).toHaveBeenCalledTimes(1);
  });

  it('opens nothing in an editor that mounts while no note is open', () => {
    const { state, reattach, reattachEditor } = shell({ boundMount: 'first', noteHeld: false });
    reattach.editorMounted('first');
    // The note a later load opens is the loader's to hand over, not this mount's.
    state.noteHeld = true;
    reattach.editorBound();

    expect(reattachEditor).not.toHaveBeenCalled();
  });
});
