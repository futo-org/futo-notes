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
  //
  // The toolbar SURFACE (items, order, grouping, labels, visibility) comes
  // from the @futo-notes/editor manifest — the same source the native shells'
  // generated ToolbarSpec files render — so the web and native toolbars
  // cannot drift. Editing behavior comes from the shared TOOLBAR_EXEC
  // registry (markdownToolbar.ts), the same commands FutoEditor.exec runs.
  import { TOOLBAR_GROUPS, TOOLBAR_DISMISS, type ToolbarItem } from '@futo-notes/editor';
  import { TOOLBAR_EXEC } from '$lib/markdownToolbar';
  import type { EditorView } from '@codemirror/view';
  import type { Component } from 'svelte';
  import {
    Bold,
    Italic,
    Strikethrough,
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

  // Manifest `lucide` names → components. A manifest item naming an icon
  // missing here is caught by the icons() check below at mount time.
  const ICONS: Record<string, Component> = {
    Bold,
    Italic,
    Strikethrough,
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
    /** User tapped a toolbar image button — post pickImage to the host. */
    onpickimage: (source: 'camera' | 'library') => void;
    /** User tapped the collapse chevron — blur the editor (hides keyboard). */
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
