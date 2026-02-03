import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { listContinuationKeymap } from '../lib/listContinuation';
import { tableRendering } from '../lib/tableRenderingField';
import { liveMarkdownTransform } from '../lib/liveMarkdownTransform';

export interface EditorOptions {
  initialContent?: string;
  onChange?: (content: string) => void;
}

export class MarkdownEditor {
  private view: EditorView;

  constructor(parent: HTMLElement, options: EditorOptions = {}) {
    const extensions = [
      listContinuationKeymap,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ base: markdownLanguage }),
      tableRendering,
      liveMarkdownTransform,
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: 'auto', fontSize: '16px' },
        '.cm-content': { padding: '16px', fontFamily: 'system-ui, sans-serif' },
        '.cm-focused': { outline: 'none' }
      })
    ];

    if (options.onChange) {
      extensions.push(
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            options.onChange!(update.state.doc.toString());
          }
        })
      );
    }

    this.view = new EditorView({
      state: EditorState.create({
        doc: options.initialContent || '',
        extensions
      }),
      parent
    });
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  setContent(content: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: content }
    });
  }

  focus(): void {
    this.view.focus();
  }

  blur(): void {
    this.view.dom.blur();
  }

  hasFocus(): boolean {
    return this.view.hasFocus;
  }

  destroy(): void {
    this.view.destroy();
  }
}
