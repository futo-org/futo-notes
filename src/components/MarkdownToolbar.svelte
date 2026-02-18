<script lang="ts">
  import { isMobile, isDesktop } from '$lib/platform';
  import {
    toggleBold,
    toggleItalic,
    toggleStrikethrough,
    toggleBulletList,
    toggleOrderedList,
    toggleTaskList,
    cycleHeading,
    toggleBlockquote,
    insertImageFromCamera,
    insertImageFromFile,
  } from '$lib/markdownToolbar';
  import { keyboard } from '$lib/keyboard.svelte';
  import type { EditorView } from '@codemirror/view';
  import {
    Bold, Italic, Strikethrough, Heading, TextQuote,
    List, ListOrdered, ListChecks, Camera, ImageIcon
  } from '@lucide/svelte';

  interface Props {
    getView: () => EditorView | null;
    editorFocused?: boolean;
    ontoolbartouch?: (touching: boolean) => void;
  }

  let { getView, editorFocused = false, ontoolbartouch }: Props = $props();

  // Only show when editor is focused (native: keyboard visible + editor focused, web/desktop: editor focused)
  const show = $derived(editorFocused && (keyboard.visible || !isMobile));

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
  let scrollEl: HTMLElement | null = $state(null);
  let touchStartX = 0;
  let touchStartScrollLeft = 0;

  function handleToolbarTouchStart(e: TouchEvent) {
    e.stopPropagation();
    ontoolbartouch?.(true);
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartScrollLeft = scrollEl?.scrollLeft ?? 0;
    }
  }

  function handleToolbarTouchMove(e: TouchEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (e.touches.length !== 1 || !scrollEl) return;
    const dx = e.touches[0].clientX - touchStartX;
    scrollEl.scrollLeft = touchStartScrollLeft - dx;
  }

  async function handleCameraImage(source: 'camera' | 'photos') {
    const view = getView();
    if (view) await insertImageFromCamera(view, source);
  }

  async function handleFileImage() {
    const view = getView();
    if (view) await insertImageFromFile(view);
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
    ><Bold size={18} strokeWidth={2.5} /></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleItalic)}
      aria-label="Italic"
    ><Italic size={18} strokeWidth={2.5} /></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleStrikethrough)}
      aria-label="Strikethrough"
    ><Strikethrough size={18} strokeWidth={2.5} /></button>

    <span class="toolbar-separator"></span>

    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(cycleHeading)}
      aria-label="Heading"
    ><Heading size={18} strokeWidth={2.5} /></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleBlockquote)}
      aria-label="Block quote"
    ><TextQuote size={18} strokeWidth={2.5} /></button>

    <span class="toolbar-separator"></span>

    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleBulletList)}
      aria-label="Bullet list"
    ><List size={18} strokeWidth={2.5} /></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleOrderedList)}
      aria-label="Ordered list"
    ><ListOrdered size={18} strokeWidth={2.5} /></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle(toggleTaskList)}
      aria-label="Task list"
    ><ListChecks size={18} strokeWidth={2.5} /></button>

    {#if isMobile}
    <span class="toolbar-separator"></span>

    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={() => handleCameraImage('camera')}
      aria-label="Take photo"
    ><Camera size={18} strokeWidth={2} /></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={() => handleCameraImage('photos')}
      aria-label="Choose from library"
    ><ImageIcon size={18} strokeWidth={2} /></button>
    {/if}

    {#if isDesktop}
    <span class="toolbar-separator"></span>

    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      onclick={handleFileImage}
      aria-label="Insert image"
    ><ImageIcon size={18} strokeWidth={2} /></button>
    {/if}
  </div>
</div>
{/if}
