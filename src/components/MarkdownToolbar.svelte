<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { Keyboard } from '@capacitor/keyboard';
  import { toggleBold, toggleItalic, toggleStrikethrough, insertImage } from '$lib/markdownToolbar';
  import { CameraSource } from '@capacitor/camera';
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

  async function handleImage(source: CameraSource) {
    const view = getView();
    if (view) await insertImage(view, source);
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
  {#if isNative}
  <button
    class="toolbar-btn"
    onmousedown={preventFocus}
    onclick={() => handleImage(CameraSource.Camera)}
    aria-label="Take photo"
  ><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></button>
  <button
    class="toolbar-btn"
    onmousedown={preventFocus}
    onclick={() => handleImage(CameraSource.Photos)}
    aria-label="Choose from library"
  ><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></button>
  {/if}
</div>
{/if}
