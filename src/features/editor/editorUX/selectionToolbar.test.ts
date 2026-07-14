// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { isInsideCode } from './selectionToolbar';

function stateFor(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

describe('isInsideCode — selection toolbar hides inside code (editor.md)', () => {
  it('is true inside inline code', () => {
    const doc = 'a `code` b';
    expect(isInsideCode(stateFor(doc), doc.indexOf('code') + 1)).toBe(true);
  });

  it('is false in plain prose', () => {
    const doc = 'plain text here';
    expect(isInsideCode(stateFor(doc), 3)).toBe(false);
  });

  it('is true inside a fenced code block', () => {
    const doc = '```\nconst x = 1;\n```';
    expect(isInsideCode(stateFor(doc), doc.indexOf('const') + 2)).toBe(true);
  });
});
