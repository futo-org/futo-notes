<script lang="ts">
  import { EditorView, keymap } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import { listContinuationKeymap } from '$lib/listContinuation';
  import { tableRendering } from '$lib/tableRenderingField';
  import { liveMarkdownTransform, preloadImages } from '$lib/liveMarkdownTransform';

  interface Props {
    content?: string;
    onchange?: (content: string) => void;
    scrollParent?: HTMLElement | null;
  }

  let { content = '', onchange, scrollParent = null }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | null = $state(null);

  // Scroll compensation state — shared between CM updateListener and scroll handler.
  // Tracks an "anchor" line at the top of the viewport. When CM recalculates
  // line heights (rendering off-screen wrapped lines), the anchor's document-relative
  // top shifts. We compensate by adjusting scrollParent.scrollTop by the delta,
  // keeping the visible content in place.
  let anchorPos = -1;
  let anchorBlockTop = 0;
  let compensating = false;

  function updateScrollAnchor(v: EditorView) {
    const sp = scrollParent;
    if (!sp || compensating) return;
    // How far into the editor is the top of the visible viewport?
    const vpTop = sp.getBoundingClientRect().top - v.dom.getBoundingClientRect().top;
    if (vpTop > 0) {
      try {
        const block = v.lineBlockAtHeight(vpTop);
        anchorPos = block.from;
        anchorBlockTop = block.top;
      } catch {
        anchorPos = -1;
      }
    } else {
      anchorPos = -1;
    }
  }

  $effect(() => {
    // content is read synchronously — tracked as $effect dependency
    preloadImages(content);

    // Reset anchor state for new editor
    anchorPos = -1;
    anchorBlockTop = 0;
    compensating = false;

    const extensions = [
      listContinuationKeymap,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ base: markdownLanguage }),
      liveMarkdownTransform,
      tableRendering,
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: 'auto', fontSize: '16px' },
        '.cm-content': {
          padding: '0',
          fontFamily: 'system-ui, sans-serif',
        },
        '.cm-focused': { outline: 'none' }
      }),
      // Scroll compensation: when CM recalculates heights (e.g. after rendering
      // wrapped lines that were previously estimated), adjust the scroll parent
      // to cancel the visible shift. This fires within the same rAF as CM's
      // measure cycle, so the correction happens before the browser paints.
      EditorView.updateListener.of(update => {
        const sp = scrollParent; // lazy read — not tracked as $effect dependency
        if (!sp) return;

        // Only compensate for rendering-induced height changes, not user edits
        if (update.heightChanged && !update.docChanged && anchorPos >= 0 && anchorPos <= update.state.doc.length) {
          try {
            const block = update.view.lineBlockAt(anchorPos);
            const delta = block.top - anchorBlockTop;
            if (Math.abs(delta) > 0.5) {
              compensating = true;
              sp.scrollTop += delta;
              anchorBlockTop = block.top;
              requestAnimationFrame(() => { compensating = false; });
            }
          } catch { /* anchor position might be invalid after large edits */ }
        }

        updateScrollAnchor(update.view);
      }),
      // Change listener — reads onchange lazily to avoid it being an $effect dependency
      EditorView.updateListener.of(update => {
        if (update.docChanged && onchange) {
          onchange(update.state.doc.toString());
        }
      })
    ];

    const v = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions
      }),
      parent: container
    });

    view = v;

    return () => {
      view?.destroy();
      view = null;
    };
  });

  // Separate effect: attach scroll listener to scrollParent to keep anchor fresh.
  // Depends on view and scrollParent, re-runs when either changes.
  $effect(() => {
    const v = view;
    const sp = scrollParent;
    if (!v || !sp) return;

    const onScroll = () => updateScrollAnchor(v);
    sp.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      sp.removeEventListener('scroll', onScroll);
    };
  });

  export function setContent(text: string): void {
    if (!view) return;
    preloadImages(text);
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
