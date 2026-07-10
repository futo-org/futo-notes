<script lang="ts">
  import { isDesktop } from '$lib/platform';
  import {
    toggleBold,
    toggleItalic,
    toggleStrikethrough,
    toggleBulletList,
    toggleOrderedList,
    toggleTaskList,
    cycleHeading,
    toggleBlockquote,
    insertImageFromFile,
  } from '$lib/markdownToolbar';
  import { keyboard } from '$lib/keyboard.svelte';
  import type { EditorView } from '@codemirror/view';
  import { indentMore, indentLess } from '@codemirror/commands';
  import {
    Bold,
    Italic,
    Strikethrough,
    Heading,
    TextQuote,
    List,
    ListOrdered,
    ListChecks,
    ImageIcon,
    ChevronDown,
    ListIndentDecrease,
    ListIndentIncrease,
  } from '@lucide/svelte';

  interface Props {
    getView: () => EditorView | null;
    editorFocused?: boolean;
    cursorOnListLine?: boolean;
    ontoolbartouch?: (touching: boolean) => void;
  }

  let {
    getView,
    editorFocused = false,
    cursorOnListLine = false,
    ontoolbartouch,
  }: Props = $props();

  // Show when editor is focused. On mobile, the toolbar sits at the bottom (above keyboard if visible).
  const show = $derived(editorFocused);

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

  async function handleFileImage() {
    const view = getView();
    if (view) await insertImageFromFile(view);
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="markdown-toolbar"
    style="bottom: {keyboard.height > 0
      ? `${keyboard.height}px`
      : `env(safe-area-inset-bottom, 0px)`}; transform: translateY({keyboard.offsetTop}px)"
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
        aria-label="Bold"><Bold size={18} strokeWidth={2.5} /></button
      >
      <button
        class="toolbar-btn"
        onmousedown={preventFocus}
        ontouchstart={preventFocus}
        onclick={handle(toggleItalic)}
        aria-label="Italic"><Italic size={18} strokeWidth={2.5} /></button
      >
      <button
        class="toolbar-btn"
        onmousedown={preventFocus}
        ontouchstart={preventFocus}
        onclick={handle(toggleStrikethrough)}
        aria-label="Strikethrough"><Strikethrough size={18} strokeWidth={2.5} /></button
      >

      <span class="toolbar-separator"></span>

      <button
        class="toolbar-btn"
        onmousedown={preventFocus}
        ontouchstart={preventFocus}
        onclick={handle(cycleHeading)}
        aria-label="Heading"><Heading size={18} strokeWidth={2.5} /></button
      >
      <button
        class="toolbar-btn"
        onmousedown={preventFocus}
        ontouchstart={preventFocus}
        onclick={handle(toggleBlockquote)}
        aria-label="Block quote"><TextQuote size={18} strokeWidth={2.5} /></button
      >

      <span class="toolbar-separator"></span>

      <button
        class="toolbar-btn"
        onmousedown={preventFocus}
        ontouchstart={preventFocus}
        onclick={handle(toggleBulletList)}
        aria-label="Bullet list"><List size={18} strokeWidth={2.5} /></button
      >
      <button
        class="toolbar-btn"
        onmousedown={preventFocus}
        ontouchstart={preventFocus}
        onclick={handle(toggleOrderedList)}
        aria-label="Ordered list"><ListOrdered size={18} strokeWidth={2.5} /></button
      >
      <button
        class="toolbar-btn"
        onmousedown={preventFocus}
        ontouchstart={preventFocus}
        onclick={handle(toggleTaskList)}
        aria-label="Task list"><ListChecks size={18} strokeWidth={2.5} /></button
      >

      {#if cursorOnListLine}
        <button
          class="toolbar-btn"
          onmousedown={preventFocus}
          ontouchstart={preventFocus}
          onclick={handle((v) => {
            indentLess(v);
          })}
          aria-label="Outdent"><ListIndentDecrease size={18} strokeWidth={2.5} /></button
        >
        <button
          class="toolbar-btn"
          onmousedown={preventFocus}
          ontouchstart={preventFocus}
          onclick={handle((v) => {
            indentMore(v);
          })}
          aria-label="Indent"><ListIndentIncrease size={18} strokeWidth={2.5} /></button
        >
      {/if}

      {#if isDesktop}
        <span class="toolbar-separator"></span>

        <button
          class="toolbar-btn"
          onmousedown={preventFocus}
          onclick={handleFileImage}
          aria-label="Insert image"><ImageIcon size={18} strokeWidth={2} /></button
        >
      {/if}
    </div>
    <button
      class="toolbar-dismiss"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={() => keyboard.hide()}
      aria-label="Dismiss keyboard"><ChevronDown size={20} strokeWidth={2.5} /></button
    >
  </div>
{/if}
