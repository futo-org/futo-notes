// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

describe('EditorView initialization (duplicate @codemirror/state guard)', () => {
  it('constructs an EditorView with project extensions without throwing', () => {
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

    const lines = container.querySelectorAll('.cm-line');
    expect(lines.length).toBeGreaterThanOrEqual(1);

    view.destroy();
    container.remove();
  });
});
