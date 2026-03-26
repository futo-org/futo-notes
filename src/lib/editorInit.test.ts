// @vitest-environment jsdom
/**
 * Regression test: editor body blank in tauri:prod.
 *
 * Root cause: duplicate @codemirror/state versions loaded simultaneously,
 * breaking instanceof checks in EditorView constructor. This test catches
 * the issue by constructing an EditorView with the same extensions the
 * app uses — if two copies of @codemirror/state are installed, the
 * constructor throws "Unrecognized extension value in extension set".
 */
import { describe, expect, it } from 'vitest';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

describe('EditorView initialization (duplicate @codemirror/state guard)', () => {
  it('constructs an EditorView with project extensions without throwing', () => {
    // This is the same extension set used in MarkdownEditor.svelte.
    // If @codemirror/state is duplicated, EditorState.create or
    // new EditorView will throw "Unrecognized extension value".
    const extensions = [
      drawSelection(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ base: markdownLanguage }),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: 'auto', fontSize: '18px' },
        '.cm-content': { padding: '0' },
      }),
    ];

    const container = document.createElement('div');
    document.body.appendChild(container);

    // This is the line that throws when @codemirror/state is duplicated:
    const view = new EditorView({
      state: EditorState.create({
        doc: '# Hello\n\nThis is a test note.',
        extensions,
      }),
      parent: container,
    });

    expect(view).toBeTruthy();
    expect(view.state.doc.toString()).toBe('# Hello\n\nThis is a test note.');
    expect(container.querySelector('.cm-editor')).toBeTruthy();
    expect(container.querySelector('.cm-content')).toBeTruthy();

    // Verify content is visible — at least one .cm-line should exist
    const lines = container.querySelectorAll('.cm-line');
    expect(lines.length).toBeGreaterThanOrEqual(1);

    view.destroy();
    container.remove();
  });
});
