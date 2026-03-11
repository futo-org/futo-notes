import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { buildSetContentTransaction } from './editorContentSync';

describe('buildSetContentTransaction', () => {
  it('preserves the cursor location during same-note content refreshes', () => {
    const state = EditorState.create({
      doc: 'alpha beta gamma',
      selection: { anchor: 6 },
    });

    const spec = buildSetContentTransaction(state, 'alpha beta gamma delta', {
      preserveSelection: true,
    });

    expect(spec).not.toBeNull();

    const nextState = state.update(spec!).state;

    expect(nextState.doc.toString()).toBe('alpha beta gamma delta');
    expect(nextState.selection.main.anchor).toBe(6);
  });

  it('maps the cursor forward when refreshed content inserts text before it', () => {
    const state = EditorState.create({
      doc: 'alpha beta gamma',
      selection: { anchor: 14 },
    });

    const spec = buildSetContentTransaction(state, 'alpha beta brave gamma', {
      preserveSelection: true,
    });

    expect(spec).not.toBeNull();

    const nextState = state.update(spec!).state;

    expect(nextState.doc.toString()).toBe('alpha beta brave gamma');
    expect(nextState.selection.main.anchor).toBe(20);
  });
});
