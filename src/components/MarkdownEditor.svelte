<script lang="ts">
  import { EditorView, keymap } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { listContinuationKeymap } from '$lib/listContinuation';
  import { tableRendering } from '$lib/tableRenderingField';
  import { liveMarkdownTransform } from '$lib/liveMarkdownTransform';

  interface Props {
    content?: string;
    onchange?: (content: string) => void;
  }

  let { content = '', onchange }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | null = $state(null);

  $effect(() => {
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
        '.cm-content': { padding: '0', fontFamily: 'system-ui, sans-serif' },
        '.cm-focused': { outline: 'none' }
      })
    ];

    if (onchange) {
      extensions.push(
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onchange(update.state.doc.toString());
          }
        })
      );
    }

    view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions
      }),
      parent: container
    });

    return () => {
      view?.destroy();
      view = null;
    };
  });

  export function setContent(text: string): void {
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text }
    });
  }

  export function focus(): void {
    view?.focus();
  }

  export function blur(): void {
    if (view) {
      view.contentDOM.blur();
      view.dom.blur();
    }
  }

  export function getContent(): string {
    return view?.state.doc.toString() ?? '';
  }

  export function hasFocus(): boolean {
    return view?.hasFocus ?? false;
  }

  export function getView(): EditorView | null {
    return view;
  }
</script>

<div bind:this={container}></div>
