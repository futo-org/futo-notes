import { EditorState, type EditorStateConfig, type Extension } from '@codemirror/state';
import { historyField } from '@codemirror/commands';

// Serialized rather than whole EditorStates: keeping states would retain every visited
// document and its syntax tree.
export interface StoredNoteHistory {
  history: unknown;
  selection: unknown;
  docLength: number;
  docHash: number;
  bytes: number;
}

// FNV-1a: identifies the text the stored positions describe without retaining it.
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// CodeMirror caps undo events (~100) but not their size — an event carries the text it removed.
const MAX_NOTES = 20;
const MAX_BYTES = 4 * 1024 * 1024;

const FIELDS = { history: historyField };

function captureState(state: EditorState): StoredNoteHistory {
  const json = state.toJSON(FIELDS) as { history: unknown; selection: unknown };
  const history = json.history;
  return {
    history,
    selection: json.selection,
    docLength: state.doc.length,
    docHash: hashText(state.doc.toString()),
    bytes: JSON.stringify(history).length,
  };
}

// Undo entries carry document positions: replaying onto different text splices unrelated
// content into the note.
export function restoreState(
  text: string,
  extensions: Extension,
  stored: StoredNoteHistory | undefined,
): EditorState {
  const config: EditorStateConfig = { extensions };
  // A stored length and hash describe the document CodeMirror built, which has already
  // collapsed CRLF. Compare against the same, or a note with Windows line endings can
  // never match its own stash.
  const doc = text.replace(/\r\n?/g, '\n');
  const usable = stored && stored.docLength === doc.length && stored.docHash === hashText(doc);
  if (!usable) return EditorState.create({ ...config, doc });
  try {
    return EditorState.fromJSON(
      { doc, selection: stored.selection, history: stored.history },
      config,
      FIELDS,
    );
  } catch (error) {
    console.warn('Discarding unreadable undo history for this note', error);
    return EditorState.create({ ...config, doc });
  }
}

export interface NoteHistoryStore {
  save: (noteId: string, state: EditorState) => void;
  take: (noteId: string) => StoredNoteHistory | undefined;
  rename: (fromId: string, toId: string) => void;
  forget: (noteId: string) => void;
  clear: () => void;
}

export function createNoteHistoryStore(
  maxNotes = MAX_NOTES,
  maxBytes = MAX_BYTES,
): NoteHistoryStore {
  // Insertion order is the LRU order: re-saving or reading a note moves it last.
  const entries = new Map<string, StoredNoteHistory>();
  let bytes = 0;

  function drop(noteId: string): void {
    const existing = entries.get(noteId);
    if (!existing) return;
    bytes -= existing.bytes;
    entries.delete(noteId);
  }

  function evict(): void {
    while (entries.size > maxNotes || (bytes > maxBytes && entries.size > 1)) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      drop(oldest.value);
    }
  }

  return {
    save(noteId, state) {
      drop(noteId);
      const captured = captureState(state);
      entries.set(noteId, captured);
      bytes += captured.bytes;
      evict();
    },
    take(noteId) {
      const existing = entries.get(noteId);
      if (!existing) return undefined;
      entries.delete(noteId);
      entries.set(noteId, existing);
      return existing;
    },
    rename(fromId, toId) {
      if (fromId === toId) return;
      const moving = entries.get(fromId);
      // Ids get reused, so whatever sat under the new id belonged to a different note.
      drop(toId);
      if (!moving) return;
      entries.delete(fromId);
      entries.set(toId, moving);
    },
    forget: drop,
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}
