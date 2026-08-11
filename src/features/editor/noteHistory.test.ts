// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';

import { createNoteHistoryStore, restoreState, type StoredNoteHistory } from './noteHistory';

const extensions = [history()];

function open(text: string, stored?: StoredNoteHistory): EditorState {
  return restoreState(text, extensions, stored);
}

function type(state: EditorState, text: string): EditorState {
  return state.update({
    changes: { from: state.doc.length, insert: text },
    userEvent: 'input.type',
  }).state;
}

function undoOn(state: EditorState): EditorState {
  let next = state;
  undo({ state, dispatch: (tr) => (next = tr.state) });
  return next;
}

describe('per-note undo history', () => {
  it('does not carry one note history into another', () => {
    const store = createNoteHistoryStore();

    let a = open('note A body');
    a = type(a, ' EDIT-IN-A');
    store.save('a', a);

    const b = open('note B body', store.take('b'));

    expect(undoDepth(b)).toBe(0);
    expect(undoOn(b).doc.toString()).toBe('note B body');
  });

  it('restores a note history when you come back to it', () => {
    const store = createNoteHistoryStore();

    let a = open('note A body');
    a = type(a, ' EDIT-IN-A');
    store.save('a', a);

    let b = open('note B body', store.take('b'));
    b = type(b, ' EDIT-IN-B');
    store.save('b', b);

    const backToA = open('note A body EDIT-IN-A', store.take('a'));
    expect(undoDepth(backToA)).toBe(1);
    expect(undoOn(backToA).doc.toString()).toBe('note A body');
  });

  it('drops history whose positions no longer describe the document', () => {
    const store = createNoteHistoryStore();
    let a = open('note A body');
    a = type(a, ' EDIT-IN-A');
    store.save('a', a);

    const changed = open('something else entirely', store.take('a'));
    expect(undoDepth(changed)).toBe(0);
    expect(undoOn(changed).doc.toString()).toBe('something else entirely');
  });

  it('evicts the least recently used note past the entry cap', () => {
    const store = createNoteHistoryStore(2);
    const state = type(open('body'), ' edit');

    store.save('a', state);
    store.save('b', state);
    store.take('a'); // 'a' is now the most recent, so 'b' is next to go
    store.save('c', state);

    expect(store.take('b')).toBeUndefined();
    expect(store.take('a')).toBeDefined();
    expect(store.take('c')).toBeDefined();
  });

  it('evicts past the byte cap', () => {
    const store = createNoteHistoryStore(50, 1);
    const state = type(open('body'), ' edit');

    store.save('a', state);
    store.save('b', state);

    expect(store.take('a')).toBeUndefined();
    expect(store.take('b')).toBeDefined();
  });

  it('forgets a single note without disturbing the others', () => {
    const store = createNoteHistoryStore();
    const state = type(open('body'), ' edit');

    store.save('a', state);
    store.save('b', state);
    store.forget('a');

    expect(store.take('a')).toBeUndefined();
    expect(store.take('b')).toBeDefined();
  });

  it('carries a stashed history through a rename of a note you are not looking at', () => {
    const store = createNoteHistoryStore();
    let ideas = open('ideas body');
    ideas = type(ideas, ' EDIT-IN-IDEAS');
    store.save('Ideas', ideas);

    store.rename('Ideas', 'Ideas 2');

    const reopened = open('ideas body EDIT-IN-IDEAS', store.take('Ideas 2'));
    expect(undoOn(reopened).doc.toString()).toBe('ideas body');
    expect(store.take('Ideas')).toBeUndefined();
  });

  it('clears whatever sat under the new id, so a reused id inherits nothing', () => {
    const store = createNoteHistoryStore();
    const state = type(open('body'), ' edit');
    store.save('stale', state);
    store.save('a', state);

    store.rename('a', 'stale');
    expect(store.take('a')).toBeUndefined();
    expect(store.take('stale')).toBeDefined();

    store.rename('gone', 'stale');
    expect(store.take('stale')).toBeUndefined();
  });
});

describe('history is only replayed onto the exact text it describes', () => {
  it('drops history when a reused note id belongs to a different note', () => {
    const store = createNoteHistoryStore();
    let a = open('SECRETXX1234');
    a = a.update({ changes: { from: 0, to: 6, insert: '' }, userEvent: 'delete.selection' }).state;
    expect(a.doc.toString()).toBe('XX1234');
    store.save('Recycle', a);

    // Same length, so only the hash keeps them apart.
    const recycled = open('ABCDEF', store.take('Recycle'));

    expect(undoDepth(recycled)).toBe(0);
    expect(undoOn(recycled).doc.toString()).toBe('ABCDEF');
  });

  it('restores a note whose file uses CRLF line endings', () => {
    const store = createNoteHistoryStore();
    const a = type(open('one\r\ntwo'), ' edit');
    store.save('a', a);

    // The reopen hands over the raw file text; CodeMirror has already collapsed the
    // stored copy, so the guard has to compare like with like.
    const reopened = open('one\r\ntwo edit', store.take('a'));

    expect(undoDepth(reopened)).toBe(1);
    expect(undoOn(reopened).doc.toString()).toBe('one\ntwo');
  });

  it('still restores when the text is byte-identical', () => {
    const store = createNoteHistoryStore();
    const a = type(open('body'), ' edit');
    store.save('a', a);

    const same = open('body edit', store.take('a'));

    expect(undoDepth(same)).toBe(1);
    expect(undoOn(same).doc.toString()).toBe('body');
  });

  it('falls back to a clean document rather than throwing on unusable history', () => {
    const store = createNoteHistoryStore();
    const a = type(open('body'), ' edit');
    store.save('a', a);
    const stored = store.take('a')!;

    const broken = { ...stored, history: { done: [{ changes: 'nonsense' }], undone: [] } };

    expect(() => open('body edit', broken)).not.toThrow();
    expect(open('body edit', broken).doc.toString()).toBe('body edit');
  });
});
