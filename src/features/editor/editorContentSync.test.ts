import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import {
  buildSetContentTransaction,
  readDocContent,
  EXTERNAL_CONTENT_OPTS,
} from './editorContentSync';

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
});
