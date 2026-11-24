interface EditorMountReattachDependencies<EditorMount> {
  /** The shell's binding reaches the editor that reported `mount`, so it can hand it a note. */
  isEditorBound: (mount: EditorMount) => boolean;
  sessionHoldsNote: () => boolean;
  reattachEditor: () => void;
}

interface EditorMountReattach<EditorMount> {
  editorMounted: (mount: EditorMount) => void;
  editorBound: () => void;
}

/**
 * An editor component mounts empty. Under a session that already holds the open note
 * that is a blank page over a file with content, so each mount is handed the session's
 * note once, as soon as the shell's binding reaches that mount. Three mounts meet such a
 * session: a dev hot reload of the editor, which remounts it behind the SAME bound object
 * (Svelte's hot-reload wrapper swaps that object's properties in place, so its identity
 * says nothing); a dev hot reload of its parent, where the binding still names the
 * destroyed editor when the new one mounts; and the first mount when a restored tab's
 * note loaded before the editor was bound. The mount and the binding land in either order.
 */
export function createEditorMountReattach<EditorMount>(
  dependencies: EditorMountReattachDependencies<EditorMount>,
): EditorMountReattach<EditorMount> {
  let mountAwaitingNote: { mount: EditorMount } | null = null;

  function attachSessionNote(): void {
    if (!mountAwaitingNote || !dependencies.isEditorBound(mountAwaitingNote.mount)) return;
    mountAwaitingNote = null;
    if (dependencies.sessionHoldsNote()) dependencies.reattachEditor();
  }

  return {
    editorMounted: (mount) => {
      mountAwaitingNote = { mount };
      attachSessionNote();
    },
    editorBound: attachSessionNote,
  };
}
