<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import {
    toggleBold,
    toggleItalic,
    toggleStrikethrough,
    toggleBulletList,
    toggleOrderedList,
    toggleTaskList,
    cycleHeading,
    toggleBlockquote,
    insertImage
  } from '$lib/markdownToolbar';
  import { CameraSource } from '@capacitor/camera';
  import { keyboard } from '$lib/keyboard.svelte';
  import type { EditorView } from '@codemirror/view';

  interface Props {
    getView: () => EditorView | null;
    editorFocused?: boolean;
    ontoolbartouch?: (touching: boolean) => void;
  }

  let { getView, editorFocused = false, ontoolbartouch }: Props = $props();

  const isNative = Capacitor.isNativePlatform();

  // Only show when editor is focused (native: keyboard visible + editor focused, web: editor focused)
  const show = $derived(editorFocused && (keyboard.visible || !isNative));

  // Compensate for Android WebView's visual viewport scrolling.
  // When the visual viewport scrolls (e.g. user drags from keyboard area upward),
  // position:fixed elements drift from their intended screen position.
  // We track the offset and apply a counter-transform.
  let vpOffset = $state(0);

  $effect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onScroll = () => { vpOffset = vv.offsetTop; };
    vv.addEventListener('scroll', onScroll);
    return () => vv.removeEventListener('scroll', onScroll);
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

  // Programmatic horizontal scroll for toolbar.
  // We use touch-action:none to fully prevent Android WebView's visual
  // viewport from scrolling when touching the toolbar. This means the
  // browser won't handle horizontal scroll natively, so we do it here.
  let scrollEl: HTMLElement | null = null;
  let touchStartX = 0;
  let touchStartScrollLeft = 0;

  function handleToolbarTouchStart(e: TouchEvent) {
    ontoolbartouch?.(true);
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartScrollLeft = scrollEl?.scrollLeft ?? 0;
    }
  }

  function handleToolbarTouchMove(e: TouchEvent) {
    e.preventDefault();
    if (e.touches.length !== 1 || !scrollEl) return;
    const dx = e.touches[0].clientX - touchStartX;
    scrollEl.scrollLeft = touchStartScrollLeft - dx;
  }

  async function handleImage(source: CameraSource) {
    const view = getView();
    if (view) await insertImage(view, source);
  }
</script>

{#if show}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="markdown-toolbar" style="bottom: {keyboard.height}px; transform: translateY({vpOffset}px)"
  ontouchstart={handleToolbarTouchStart}
  ontouchmove={handleToolbarTouchMove}
  ontouchend={() => ontoolbartouch?.(false)}
  ontouchcancel={() => ontoolbartouch?.(false)}
>
  <div class="toolbar-scroll" bind:this={scrollEl}>
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

    {#if isNative}
    <span class="toolbar-separator"></span>

    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={() => handleImage(CameraSource.Camera)}
      aria-label="Take photo"
    ><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={() => handleImage(CameraSource.Photos)}
      aria-label="Choose from library"
    ><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></button>
    {/if}
  </div>
</div>
{/if}
