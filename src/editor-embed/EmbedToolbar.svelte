<script lang="ts">
  import { TOOLBAR_GROUPS, TOOLBAR_DISMISS, type ToolbarItem } from '@futo-notes/editor';
  import { TOOLBAR_EXEC } from '$features/editor/markdownToolbar';
  import type { EditorView } from '@codemirror/view';
  import type { Component } from 'svelte';
  import {
    Bold,
    Italic,
    Strikethrough,
    Link,
    Heading,
    TextQuote,
    List,
    ListOrdered,
    ListChecks,
    Camera,
    ImageIcon,
    ChevronDown,
    ListIndentDecrease,
    ListIndentIncrease,
  } from '@lucide/svelte';

  const ICONS: Record<string, Component> = {
    Bold,
    Italic,
    Strikethrough,
    Link,
    Heading,
    TextQuote,
    List,
    ListOrdered,
    ListChecks,
    Camera,
    ImageIcon,
    ChevronDown,
    ListIndentDecrease,
    ListIndentIncrease,
  };

  interface Props {
    getView: () => EditorView | null;
    onpickimage: (source: 'camera' | 'library') => void;
    ondismiss: () => void;
  }

  let { getView, onpickimage, ondismiss }: Props = $props();

  function icon(item: ToolbarItem): Component {
    const c = ICONS[item.lucide];
    if (!c) throw new Error(`EmbedToolbar: no icon registered for '${item.lucide}'`);
    return c;
  }

  const DismissIcon = icon(TOOLBAR_DISMISS);

  function activate(item: ToolbarItem): void {
    const action = item.action;
    if (action.kind === 'dismiss') {
      ondismiss();
    } else if (action.kind === 'pickImage') {
      onpickimage(action.source);
    } else {
      const view = getView();
      if (view) TOOLBAR_EXEC[item.id]?.(view);
    }
  }

  let editorFocused = $state(false);
  let cursorOnListLine = $state(false);

  export function setFocused(focused: boolean): void {
    editorFocused = focused;
  }

  export function setCursorContext(onListLine: boolean): void {
    cursorOnListLine = onListLine;
  }

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

  function preventFocus(e: MouseEvent | TouchEvent) {
    e.preventDefault();
  }

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
  <div
    class="markdown-toolbar"
    style="bottom: {bottomOffset > 0 ? `${bottomOffset}px` : `env(safe-area-inset-bottom, 0px)`}"
    ontouchstart={handleToolbarTouchStart}
    ontouchmove={handleToolbarTouchMove}
  >
    <div class="toolbar-scroll" bind:this={scrollEl}>
      {#each TOOLBAR_GROUPS as group, groupIndex (groupIndex)}
        {#if groupIndex > 0}
          <span class="toolbar-separator"></span>
        {/if}
        {#each group as item (item.id)}
          {#if item.when !== 'onListLine' || cursorOnListLine}
            {@const Icon = icon(item)}
            <button
              class="toolbar-btn"
              onmousedown={preventFocus}
              ontouchstart={preventFocus}
              onclick={() => activate(item)}
              aria-label={item.label}
              ><Icon size={18} strokeWidth={item.action.kind === 'pickImage' ? 2 : 2.5} /></button
            >
          {/if}
        {/each}
      {/each}
    </div>
    <button
      class="toolbar-dismiss"
      onmousedown={preventFocus}
      ontouchstart={preventFocus}
      onclick={() => activate(TOOLBAR_DISMISS)}
      aria-label={TOOLBAR_DISMISS.label}><DismissIcon size={20} strokeWidth={2.5} /></button
    >
  </div>
{/if}
