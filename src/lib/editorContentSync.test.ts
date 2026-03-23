import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { buildSetContentTransaction } from './editorContentSync';

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
});
