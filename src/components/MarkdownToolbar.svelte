<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { toggleBold, toggleItalic, toggleStrikethrough } from '$lib/markdownToolbar';
  import { keyboard } from '$lib/keyboard.svelte';
  import type { EditorView } from '@codemirror/view';

  interface Props {
    getView: () => EditorView | null;
    editorFocused?: boolean;
  }

  let { getView, editorFocused = false }: Props = $props();

  const isNative = Capacitor.isNativePlatform();

  // Only show when editor is focused (native: keyboard visible + editor focused, web: editor focused)
  const show = $derived(editorFocused && (keyboard.visible || !isNative));

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
<div class="markdown-toolbar" style="bottom: {keyboard.height}px">
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
