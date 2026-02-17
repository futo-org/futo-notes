<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { Keyboard } from '@capacitor/keyboard';
  import {
    toggleBold,
    toggleItalic,
    toggleStrikethrough,
    toggleBulletList,
    toggleOrderedList,
    toggleTaskList,
    cycleHeading,
    toggleBlockquote
  } from '$lib/markdownToolbar';
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
  function preventFocus(e: MouseEvent | TouchEvent) {
    e.preventDefault();
  }
</script>

{#if show}
<div class="markdown-toolbar" style="bottom: {keyboardHeight}px">
  <div class="toolbar-scroll">
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleBold)}
      aria-label="Bold"
    ><strong>B</strong></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleItalic)}
      aria-label="Italic"
    ><em>I</em></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleStrikethrough)}
      aria-label="Strikethrough"
    ><span class="toolbar-strikethrough">S</span></button>

    <span class="toolbar-separator"></span>

    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(cycleHeading)}
      aria-label="Heading"
    >H</button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleBlockquote)}
      aria-label="Block quote"
    ><span class="toolbar-quote">"</span></button>

    <span class="toolbar-separator"></span>

    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleBulletList)}
      aria-label="Bullet list"
    ><span class="toolbar-icon">•&ensp;―</span></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleOrderedList)}
      aria-label="Ordered list"
    ><span class="toolbar-icon">1.&ensp;―</span></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleTaskList)}
      aria-label="Task list"
    ><span class="toolbar-icon">☐</span></button>
  </div>
</div>
{/if}
