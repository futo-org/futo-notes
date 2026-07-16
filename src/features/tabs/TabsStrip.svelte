<script lang="ts">
  import { tabsStore, type Tab } from './tabsStore.svelte';
  import type { NotePreview } from '$shared/types/note';
  import { idLeaf } from '$lib/platform/pathSafety';
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

  // HTML5 drag reorder: the tabs move live under the cursor (moveTab on
  // midpoint crossing), so the reordering strip itself is the drop feedback.
  let dragIndex: number | null = $state(null);

  function onDragStart(e: DragEvent, index: number): void {
    if ((e.target as HTMLElement).closest('.tab-close-btn')) {
      e.preventDefault();
      return;
    }
    dragIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tabsStore.tabs[index]?.id ?? '');
    }
  }

  function onDragOver(e: DragEvent, index: number): void {
    if (dragIndex === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (index === dragIndex) return;
    // Only reorder once the cursor crosses the hovered tab's midpoint in the
    // direction of travel — reordering on mere overlap oscillates when tabs
    // have different widths.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    const movingRight = index > dragIndex;
    if ((movingRight && e.clientX > midpoint) || (!movingRight && e.clientX < midpoint)) {
      tabsStore.moveTab(dragIndex, index);
      dragIndex = index;
    }
  }

  function onDragEnd(): void {
    dragIndex = null;
  }

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
<div class="tabs-strip" role="tablist" aria-label="Tabs" data-tauri-drag-region>
  {#each tabsStore.tabs as tab, idx (tab.id)}
    <button
      type="button"
      class="tab-pill"
      class:active={tab.id === tabsStore.activeTabId}
      class:dragging={idx === dragIndex}
      role="tab"
      aria-selected={tab.id === tabsStore.activeTabId}
      data-tab-id={tab.id}
      draggable="true"
      onclick={() => tabsStore.activateById(tab.id)}
      ondragstart={(e) => onDragStart(e, idx)}
      ondragover={(e) => onDragOver(e, idx)}
      ondrop={(e) => e.preventDefault()}
      ondragend={onDragEnd}
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
