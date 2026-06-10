<script lang="ts">
  // Native-shell markdown toolbar for the embedded editor (editor.html).
  //
  // Mirrors components/MarkdownToolbar.svelte (same commands, same
  // .markdown-toolbar / .toolbar-* CSS from styles/components.css — the embed
  // already imports app.css) but with the host-dependent pieces swapped out:
  //  - image buttons post {type:'pickImage'} to the native host instead of
  //    calling the Tauri camera/file plugins,
  //  - the dismiss chevron blurs the editor (dropping the soft keyboard)
  //    instead of keyboard.hide(),
  //  - keyboard docking reads window.visualViewport directly (covers iOS
  //    overlay keyboards AND Android adjustResize) instead of the Tauri
  //    keyboard.svelte store.
  //
  // main.ts is a plain TS module (no runes), so visibility and cursor context
  // are driven through the exported setters below rather than reactive props.
  import {
    toggleBold,
    toggleItalic,
    toggleStrikethrough,
    toggleBulletList,
    toggleOrderedList,
    toggleTaskList,
    cycleHeading,
    toggleBlockquote,
  } from '$lib/markdownToolbar';
  import type { EditorView } from '@codemirror/view';
  import { indentMore, indentLess } from '@codemirror/commands';
  import {
    Bold, Italic, Strikethrough, Heading, TextQuote,
    List, ListOrdered, ListChecks, Camera, ImageIcon, ChevronDown,
    ListIndentDecrease, ListIndentIncrease
  } from '@lucide/svelte';

  interface Props {
    getView: () => EditorView | null;
    /** User tapped a toolbar image button — post pickImage to the host. */
    onpickimage: (source: 'camera' | 'library') => void;
    /** User tapped the collapse chevron — blur the editor (hides keyboard). */
    ondismiss: () => void;
  }

  let { getView, onpickimage, ondismiss }: Props = $props();

  // Show while the editor is focused. Wired from main.ts's onfocuschange.
  let editorFocused = $state(false);
  let cursorOnListLine = $state(false);

  export function setFocused(focused: boolean): void {
    editorFocused = focused;
  }

  export function setCursorContext(onListLine: boolean): void {
    cursorOnListLine = onListLine;
  }

  // Dock above the soft keyboard: the visual viewport shrinks (iOS overlay
  // keyboards, Android adjustResize) or pans (offsetTop) when it shows, so
  // the fixed toolbar's bottom is the layout-viewport space the keyboard
  // covers. 0 when no keyboard.
  let bottomOffset = $state(0);

  function updateBottomOffset(): void {
    const vv = window.visualViewport;
    bottomOffset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  }

  $effect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    updateBottomOffset();
    vv.addEventListener('resize', updateBottomOffset);
    vv.addEventListener('scroll', updateBottomOffset);
    return () => {
      vv.removeEventListener('resize', updateBottomOffset);
      vv.removeEventListener('scroll', updateBottomOffset);
    };
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
  // .markdown-toolbar uses touch-action:none to fully prevent the WebView's
  // visual viewport from scrolling when touching the toolbar. This means the
  // browser won't handle horizontal scroll natively, so we do it here.
  let scrollEl: HTMLElement | null = $state(null);
  let touchStartX = 0;
  let touchStartScrollLeft = 0;

  function handleToolbarTouchStart(e: TouchEvent) {
    e.stopPropagation();
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
</script>

{#if editorFocused}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="markdown-toolbar" style="bottom: {bottomOffset > 0 ? `${bottomOffset}px` : `env(safe-area-inset-bottom, 0px)`}"
  ontouchstart={handleToolbarTouchStart}
  ontouchmove={handleToolbarTouchMove}
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

    {#if cursorOnListLine}
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle((v) => { indentLess(v); })}
      aria-label="Outdent"
    ><ListIndentDecrease size={18} strokeWidth={2.5} /></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={handle((v) => { indentMore(v); })}
      aria-label="Indent"
    ><ListIndentIncrease size={18} strokeWidth={2.5} /></button>
    {/if}

    <span class="toolbar-separator"></span>

    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={() => onpickimage('camera')}
      aria-label="Take photo"
    ><Camera size={18} strokeWidth={2} /></button>
    <button
      class="toolbar-btn"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={() => onpickimage('library')}
      aria-label="Choose from library"
    ><ImageIcon size={18} strokeWidth={2} /></button>
  </div>
  <button
    class="toolbar-dismiss"
    onmousedown={preventFocus}
    ontouchstart={preventFocus}
    onclick={ondismiss}
    aria-label="Dismiss keyboard"
  ><ChevronDown size={20} strokeWidth={2.5} /></button>
</div>
{/if}
