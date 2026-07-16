<script lang="ts">
  import { tabsStore, type Tab } from './tabsStore.svelte';
  import type { NotePreview } from '$shared/types/note';
  import { idLeaf } from '$lib/platform/pathSafety';
  import { createTabDrag } from './createTabDrag.svelte';
  import './tabsStrip.css';

  interface Props {
    notes?: NotePreview[];
  }

  let { notes = [] }: Props = $props();

  const titleById = $derived.by(() => {
    const m = new Map<string, string>();
    for (const n of notes) m.set(n.id, n.title);
    return m;
  });

  function titleFor(tab: Tab): string {
    const id = tab.noteId;
    if (id === null) return 'Home';
    if (id === 'new') return 'New note';
    const title = titleById.get(id);
    if (title) return title.split('/').pop() || title;
    return idLeaf(id);
  }

  let stripEl: HTMLDivElement | undefined = $state(undefined);
  const tabDrag = createTabDrag({
    getStripElement: () => stripEl,
    getTabs: () => tabsStore.tabs,
    activateTab: tabsStore.activateById,
    moveTab: tabsStore.moveTab,
  });

  function onAuxClick(e: MouseEvent, tab: Tab): void {
    if (e.button === 1) {
      e.preventDefault();
      tabsStore.closeTab(tab.id);
    }
  }

  function onCloseClick(e: MouseEvent, tab: Tab): void {
    e.preventDefault();
    e.stopPropagation();
    tabsStore.closeTab(tab.id);
  }

  function onNewTabClick(): void {
    tabsStore.newTab();
  }
</script>

<!-- The strip itself is a `data-tauri-drag-region` so users can drag the
     window by its empty area (next to / between tabs). Tauri's drag
     region only applies to the element that has the attribute directly,
     so child buttons (tab pills, "+") still receive clicks normally.
     This replaces the previous separate full-width drag overlay that
     was hiding the upper rim of every tab. -->
<div class="tabs-strip" bind:this={stripEl} role="tablist" aria-label="Tabs" data-tauri-drag-region>
  {#each tabsStore.tabs as tab, idx (tab.id)}
    <button
      type="button"
      class="tab-pill"
      class:active={tab.id === tabsStore.activeTabId}
      class:dragging={tab.id === tabDrag.dragTabId}
      role="tab"
      aria-selected={tab.id === tabsStore.activeTabId}
      data-tab-id={tab.id}
      style={tabDrag.getTabStyle(tab, idx)}
      onpointerdown={(e) => tabDrag.handlePointerDown(e, tab)}
      onpointermove={tabDrag.handlePointerMove}
      onpointerup={(e) => tabDrag.handlePointerUp(e, tab)}
      onauxclick={(e) => onAuxClick(e, tab)}
      title={titleFor(tab)}
    >
      <span class="tab-title">{titleFor(tab)}</span>
      <span
        class="tab-close-btn"
        role="button"
        tabindex="-1"
        aria-label="Close tab"
        onclick={(e) => onCloseClick(e, tab)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            tabsStore.closeTab(tab.id);
          }
        }}>×</span
      >
    </button>
  {/each}
  <button
    type="button"
    class="tab-new-btn"
    aria-label="New tab"
    title="New tab"
    onclick={onNewTabClick}>+</button
  >
</div>
