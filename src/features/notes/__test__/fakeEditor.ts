import { vi } from 'vitest';
import { createNoteSession } from '../noteSession.svelte.ts';
import type { NoteSession, NoteSessionDeps } from '../noteSession.svelte.ts';

/**
 * The desktop editor and its host as the session sees them (DesktopEditor.svelte): it
 * opens a note's bytes from `disk`, holds the draft and what it last saved, writes it on
 * a save, moves it on a rename, and switches notes the way the host does: the outgoing
 * note is saved (or discarded) and released, and a failed save leaves it held. It
 * reports each landing back
 * through the session's `followEditorNote` and `editorSaved`, as `onnote` and `onsaved`
 * do. `failSaves` makes every write throw, as a vault that refuses writes does.
 */
export function createFakeEditor(disk = new Map<string, string>()) {
  let noteId: string | null = null;
  /** The note the host last told the session it holds. */
  let reported: string | null = null;
  let draft: string | undefined;
  let saved: string | undefined;
  let failSaves = false;
  /** False while a switch runs: DesktopEditor shows no note until the host answers. */
  let showing = true;
  let session: NoteSession | undefined;

  /** Every host outcome names the note the attachment holds. */
  function report(): void {
    if (reported === null || noteId === null || reported === noteId) return;
    const fromId = reported;
    reported = noteId;
    session?.followEditorNote(fromId, noteId, false);
  }

  /** The host's save: nothing written for a draft unedited since its last save, or one
   *  disk already holds. */
  function write(): void {
    report();
    if (noteId === null || draft === undefined || draft === saved) return;
    if (failSaves) throw new Error('the vault refuses writes');
    saved = draft;
    if (disk.get(noteId) === draft) return;
    disk.set(noteId, draft);
    session?.editorSaved();
  }

  function attach(id: string | null): void {
    showing = true;
    noteId = id;
    reported = id;
    draft = id === null ? undefined : (disk.get(id) ?? '');
    saved = draft;
  }

  /** The host's reload, and in this fake its adoption of an outside change too: the note
   *  as disk holds it after the draft's save. */
  function readBack(): void {
    write();
    attach(noteId);
  }

  const deps = {
    getEditorContent: () => (showing ? draft : undefined),
    getEditorSavedSource: () => (noteId === null ? undefined : saved),
    getEditorNoteId: () => (showing ? reported : null),
    isEditorIdle: () => draft === saved,
    reloadEditorNote: vi.fn(readBack),
    takeOutsideEditorChange: vi.fn(readBack),
    openEditorNote: vi.fn(async (id: string | null, discardUnsaved: boolean) => {
      if (!discardUnsaved) write();
      attach(id);
    }),
    saveEditorNote: vi.fn(async () => write()),
    /** The host names the destination: `title` in the folder the note is in. */
    renameEditorNote: vi.fn(async (title: string) => {
      if (failSaves) throw new Error('the vault refuses writes');
      const fromId = reported ?? noteId!;
      const folder = noteId!.includes('/') ? noteId!.slice(0, noteId!.lastIndexOf('/')) : '';
      const wantedId = folder ? `${folder}/${title}` : title;
      disk.delete(noteId!);
      disk.set(wantedId, draft ?? '');
      noteId = wantedId;
      reported = wantedId;
      saved = draft;
      session?.followEditorNote(fromId, wantedId, false);
      session?.editorSaved();
    }),
  };

  return {
    deps,
    disk,
    connect(connected: NoteSession) {
      session = connected;
    },
    get noteId() {
      return noteId;
    },
    get draft() {
      return draft;
    },
    set failSaves(failing: boolean) {
      failSaves = failing;
    },
    /** Typing, reported as the editor's coalesced edit. */
    type(text: string) {
      draft = text;
      session?.editorEdited();
    },
    /** The view shows no note while the host switches (DesktopEditor `attach`). */
    hide() {
      showing = false;
    },
    /** Typing whose change report has not arrived yet. */
    keystroke(text: string) {
      draft = text;
    },
    /** The host's own timer saved the draft. */
    hostSave: write,
    /** The host's timer found the note changed and parked the draft as `copyId`. */
    park(copyId: string) {
      const fromId = noteId!;
      disk.set(copyId, draft ?? '');
      noteId = copyId;
      reported = copyId;
      saved = draft;
      session?.followEditorNote(fromId, copyId, true);
      session?.editorSaved();
    },
    /** A store workflow moved the note (a move, a sync relocation) and the attachment
     *  with it; the host's next outcome reports it. */
    relocate(toId: string) {
      const fromId = noteId!;
      if (disk.has(fromId)) {
        disk.set(toId, disk.get(fromId)!);
        disk.delete(fromId);
      }
      noteId = toId;
    },
    /** As `relocate`, reported at once (the host's event). */
    moved(toId: string) {
      this.relocate(toId);
      report();
    },
  };
}

export type FakeEditor = ReturnType<typeof createFakeEditor>;

/** A session over `editor`, with inert shell deps; the active tab shows the session's note. */
export function sessionOver(editor: FakeEditor, overrides: Partial<NoteSessionDeps> = {}) {
  const deps = {
    ...editor.deps,
    focusEditor: vi.fn(),
    isEditorFocused: () => false,
    isComposing: () => false,
    getNotes: () => [],
    getNoteBody: () => undefined,
    getTitleTextarea: () => undefined,
    getNoteId: (): string | null => session.originalId,
    setPrevNoteId: vi.fn(),
    onNoteRenamed: vi.fn(),
    onNoteDeleted: vi.fn(),
    navigate: vi.fn(),
    ...overrides,
  } satisfies NoteSessionDeps;
  const session = createNoteSession(deps);
  editor.connect(session);
  return { session, deps };
}
