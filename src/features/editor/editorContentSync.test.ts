import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import {
  buildSetContentTransaction,
  readDocContent,
  EXTERNAL_CONTENT_OPTS,
} from './editorContentSync';
import { orderedListRenumber } from './orderedListRenumber';

describe('readDocContent', () => {
  it('reads the live document', () => {
    const state = EditorState.create({ doc: 'hello' });
    expect(readDocContent({ state })).toBe('hello');
  });

  it('reads a genuinely empty document as the empty string', () => {
    const state = EditorState.create({ doc: '' });
    expect(readDocContent({ state })).toBe('');
  });

  it('returns undefined — never empty string — when the view is gone', () => {
    expect(readDocContent(null)).toBeUndefined();
  });
});

describe('buildSetContentTransaction', () => {
  it('preserves the cursor location during same-note content refreshes', () => {
    const state = EditorState.create({
      doc: 'alpha beta gamma',
      selection: { anchor: 6 },
    });

    const result = buildSetContentTransaction(state, 'alpha beta gamma delta', {
      preserveSelection: true,
    });

    expect(result).not.toBeNull();

    const nextState = state.update(result!.spec).state;

    expect(nextState.doc.toString()).toBe('alpha beta gamma delta');
    expect(nextState.selection.main.anchor).toBe(6);
  });

  it('maps the cursor forward when refreshed content inserts text before it', () => {
    const state = EditorState.create({
      doc: 'alpha beta gamma',
      selection: { anchor: 14 },
    });

    const result = buildSetContentTransaction(state, 'alpha beta brave gamma', {
      preserveSelection: true,
    });

    expect(result).not.toBeNull();

    const nextState = state.update(result!.spec).state;

    expect(nextState.doc.toString()).toBe('alpha beta brave gamma');
    expect(nextState.selection.main.anchor).toBe(20);
  });

  it('returns null when content is unchanged', () => {
    const state = EditorState.create({ doc: 'hello world' });
    expect(buildSetContentTransaction(state, 'hello world')).toBeNull();
  });

  it('does not mistake an unsampled same-length edit in a long document for equality', () => {
    const before = 'a'.repeat(400);
    const after = `${before.slice(0, 50)}b${before.slice(51)}`;
    const state = EditorState.create({ doc: before });

    const result = buildSetContentTransaction(state, after, { preserveSelection: true });

    expect(result).not.toBeNull();
    expect(state.update(result!.spec).state.doc.toString()).toBe(after);
  });

  it('returns only the inserted text for incremental changes', () => {
    const state = EditorState.create({ doc: 'hello world' });
    const result = buildSetContentTransaction(state, 'hello brave world', {
      preserveSelection: true,
    });

    expect(result).not.toBeNull();
    expect(result!.insertedText).toBe('brave ');
  });

  // github#33. A host push WITHOUT preserveSelection replaces the whole document,
  // and CodeMirror maps a caret inside a replaced range to its start — so the
  // caret lands at offset 0 however deep in the note the user was. If one of these
  // arrives while someone is typing, their next committed word is inserted at the
  // head of the note, and the IME, now told the cursor is 0 with nothing before it,
  // capitalizes it as a sentence start and omits the leading space. That is exactly
  // the signature reported in github#33 (`"Zzz \nline-1 aaaa…"` at the head of a
  // 400-line note whose caret was at line 393), and it is engine-independent — the
  // legacy WebView has nothing to do with it. Locked here so the caret cost of a
  // full push stays visible to whoever adds the next caller.
  it('drops the caret to the document start on a full non-preserveSelection push', () => {
    const doc = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
    const state = EditorState.create({ doc, selection: { anchor: doc.length - 3 } });

    const result = buildSetContentTransaction(state, `${doc}\nline-41`, {
      preserveSelection: false,
    });

    expect(result).not.toBeNull();
    expect(state.update(result!.spec).state.selection.main.anchor).toBe(0);
  });

  // The contrast that makes the above a choice rather than an accident: the same
  // arriving text through EXTERNAL_CONTENT_OPTS (what a sync adopt uses) keeps the
  // caret where the user left it, so a peer's edit never re-homes their cursor.
  it('keeps the caret where the user left it when the same text arrives as an adopt', () => {
    const doc = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
    const state = EditorState.create({ doc, selection: { anchor: doc.length - 3 } });

    const result = buildSetContentTransaction(state, `${doc}\nline-41`, EXTERNAL_CONTENT_OPTS);

    expect(result).not.toBeNull();
    expect(state.update(result!.spec).state.selection.main.anchor).toBe(doc.length - 3);
  });

  it('returns full text as insertedText for non-preserveSelection', () => {
    const state = EditorState.create({ doc: 'hello' });
    const result = buildSetContentTransaction(state, 'goodbye');

    expect(result).not.toBeNull();
    expect(result!.insertedText).toBe('goodbye');
  });

  it('suffix scan does not corrupt content when old and new share trailing chars', () => {
    const state = EditorState.create({ doc: 'Note A body with some text.' });
    const nextText = 'Note B has different content entirely.';
    const result = buildSetContentTransaction(state, nextText, { preserveSelection: true });

    expect(result).not.toBeNull();
    const next = state.update(result!.spec).state;
    expect(next.doc.toString()).toBe(nextText);
  });
});

describe('EXTERNAL_CONTENT_OPTS', () => {
  function undoOn(state: EditorState): EditorState {
    let next = state;
    undo({ state, dispatch: (tr) => (next = tr.state) });
    return next;
  }

  it('leaves text that arrived from outside beyond undo reach', () => {
    let state = EditorState.create({ doc: 'local', extensions: [history()] });
    state = state.update({
      changes: { from: 5, insert: ' edit' },
      userEvent: 'input.type',
    }).state;
    expect(state.doc.toString()).toBe('local edit');

    const adopt = buildSetContentTransaction(state, 'peer version', EXTERNAL_CONTENT_OPTS);
    state = state.update(adopt!.spec).state;

    // Undo takes back the local keystroke, never the adopt: reviving the superseded
    // local text is what the autosave would then push back over the peer's.
    expect(undoOn(state).doc.toString()).toBe('peer version');
  });

  // A transaction filter that treats an adopt like typing rewrites the peer's text on
  // arrival, marks the doc dirty, and autosaves that rewrite straight back out to every
  // other client. Adopted text lands byte for byte or not at all.
  describe('adopted text is not edited on arrival', () => {
    function adoptInto(startDoc: string, incoming: string): string {
      const state = EditorState.create({
        doc: startDoc,
        extensions: [history(), orderedListRenumber],
      });
      const adopt = buildSetContentTransaction(state, incoming, EXTERNAL_CONTENT_OPTS);
      expect(adopt).not.toBeNull();
      return state.update(adopt!.spec).state.doc.toString();
    }

    it('leaves a hand-numbered ordered list exactly as the peer wrote it', () => {
      expect(adoptInto('local', '1. a\n1. b')).toBe('1. a\n1. b');
    });

    it('leaves empty lazily-numbered items alone', () => {
      expect(adoptInto('local', '1. \n1. ')).toBe('1. \n1. ');
    });
  });
});
