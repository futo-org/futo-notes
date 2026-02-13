<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { Keyboard } from '@capacitor/keyboard';
  import { toggleBold, toggleItalic, toggleStrikethrough } from '$lib/markdownToolbar';
  import type { EditorView } from '@codemirror/view';

  interface Props {
    getView: () => EditorView | null;
    editorFocused?: boolean;
  }

  let { getView, editorFocused = false }: Props = $props();

  let keyboardHeight = $state(0);
  let keyboardVisible = $state(false);

  const isNative = Capacitor.isNativePlatform();

  // Only show when editor is focused (native: keyboard visible + editor focused, web: editor focused)
  const show = $derived(editorFocused && (keyboardVisible || !isNative));

  $effect(() => {
    if (isNative) {
      const showHandle = Keyboard.addListener('keyboardWillShow', (info) => {
        keyboardHeight = info.keyboardHeight;
        keyboardVisible = true;
      });
      const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
        keyboardHeight = 0;
        keyboardVisible = false;
      });

      return () => {
        showHandle.then(h => h.remove());
        hideHandle.then(h => h.remove());
      };
    } else {
      // Web fallback: detect virtual keyboard via visualViewport
      const vv = window.visualViewport;
      if (!vv) return;

      const onResize = () => {
        const diff = window.innerHeight - vv.height;
        if (diff > 100) {
          keyboardHeight = diff;
          keyboardVisible = true;
        } else {
          keyboardHeight = 0;
          keyboardVisible = false;
        }
      };

      vv.addEventListener('resize', onResize);
      return () => vv.removeEventListener('resize', onResize);
    }
  });

  function handle(fn: (view: EditorView) => void) {
    return () => {
      const view = getView();
      if (view) fn(view);
    };
  }

  // Prevent focus steal from editor
  function preventFocus(e: MouseEvent) {
    e.preventDefault();
  }
</script>

{#if show}
<div class="markdown-toolbar" style="bottom: {keyboardHeight}px">
  <button
    class="toolbar-btn"
    onmousedown={preventFocus}
    onclick={handle(toggleBold)}
    aria-label="Bold"
  ><strong>B</strong></button>
  <button
    class="toolbar-btn"
    onmousedown={preventFocus}
    onclick={handle(toggleItalic)}
    aria-label="Italic"
  ><em>I</em></button>
  <button
    class="toolbar-btn"
    onmousedown={preventFocus}
    onclick={handle(toggleStrikethrough)}
    aria-label="Strikethrough"
  ><span class="toolbar-strikethrough">S</span></button>
</div>
{/if}
