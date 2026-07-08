<script lang="ts">
  import { getContext } from 'svelte';
  import { tabsStore, type Tab } from '$lib/tabsStore.svelte';
  import { APP_CONTEXT_KEY, type AppContext } from '$lib/appContext.svelte';
  import { idLeaf } from '$lib/platform/pathSafety';

  interface Props {
    sidebarCollapsed?: boolean;
    onExpandSidebar?: () => void;
  }

  let { sidebarCollapsed = false, onExpandSidebar = () => {} }: Props = $props();

  const appCtx = getContext<AppContext>(APP_CONTEXT_KEY);

  // Build an id→title map once per notes update so the per-pill lookup is O(1).
  // Without this, every drag pointermove (which mutates dragDeltaX) re-renders
  // every pill and re-runs Array.prototype.find against the full notes list.
  const titleById = $derived.by(() => {
    const m = new Map<string, string>();
    for (const n of appCtx.notes) m.set(n.id, n.title);
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

  // ── Drag reorder via pointer events ─────────────────────────────────
  //
  // Physical-feel drag: the picked-up pill follows the cursor; the other
  // pills shift aside with a CSS transition to show where it will land.
  // The array itself only changes once, on drop. After commit, a brief
  // FLIP-style transform slides the dropped pill from its cursor position
  // into its final slot so it doesn't snap.
  let stripEl: HTMLDivElement | undefined = $state(undefined);
  let dragTabId: string | null = $state(null);
  let dragDeltaX = $state(0);
  let dragStartX = 0;
  let dragStartIdx = -1;
  let dragTargetIdx = $state(-1);
  let pillRects: { left: number; width: number }[] = [];
  const DRAG_THRESHOLD = 6;
  let dragStarted = false;
  // The previous drop's transitionend listener — cancel it if the user starts
  // a new drag before the FLIP animation finishes, otherwise listeners leak.
  let pendingFlipCleanup: (() => void) | null = null;

  function onPointerDown(e: PointerEvent, tab: Tab): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tab-close-btn')) return;
    // Cancel any in-flight FLIP from a previous drop so its listener doesn't leak.
    pendingFlipCleanup?.();
    pendingFlipCleanup = null;
    const idx = tabsStore.tabs.findIndex((t) => t.id === tab.id);
    if (idx === -1 || !stripEl) return;
    const pills = stripEl.querySelectorAll<HTMLElement>('[data-tab-id]');
    pillRects = Array.from(pills).map((p) => {
      const r = p.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
    dragTabId = tab.id;
    dragStartIdx = idx;
    dragTargetIdx = idx;
    dragStartX = e.clientX;
    dragDeltaX = 0;
    dragStarted = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (dragTabId === null) return;
    const dx = e.clientX - dragStartX;
    if (!dragStarted && Math.abs(dx) >= DRAG_THRESHOLD) {
      dragStarted = true;
    }
    if (!dragStarted) return;
    dragDeltaX = dx;
    // Pick the target slot based on where the cursor sits in the originally
    // measured layout.
    let target = dragStartIdx;
    for (let i = 0; i < pillRects.length; i++) {
      const r = pillRects[i]!;
      const center = r.left + r.width / 2;
      if (e.clientX < center) {
        target = i;
        break;
      }
      target = i;
    }
    if (target !== dragTargetIdx) dragTargetIdx = target;
  }

  function onPointerUp(e: PointerEvent, tab: Tab): void {
    const wasDrag = dragStarted;
    const id = dragTabId;
    const startIdx = dragStartIdx;
    const targetIdx = dragTargetIdx;
    const finalDeltaX = dragDeltaX;
    const draggedWidth = pillRects[startIdx]?.width ?? 0;

    dragTabId = null;
    dragStarted = false;
    dragDeltaX = 0;
    dragStartIdx = -1;
    dragTargetIdx = -1;
    pillRects = [];

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }

    if (!wasDrag && id === tab.id) {
      if (e.button === 0) tabsStore.activateById(tab.id);
      return;
    }

    if (id === null || targetIdx === -1) return;

    if (targetIdx !== startIdx) {
      tabsStore.moveTab(startIdx, targetIdx);
    }

    // FLIP: slide the dropped pill from its picked-up position into its
    // final slot. We measure where the pill landed, set a transform that
    // matches the cursor's last visual offset, then animate it to 0.
    queueMicrotask(() => {
      if (!stripEl) return;
      const pill = stripEl.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`);
      if (!pill) return;
      // The pill's natural position has shifted by (targetIdx - startIdx) slots.
      // The cursor's last visual offset relative to that final slot is:
      //   pickupOffsetFromStart + finalDeltaX - (slotShiftPx)
      // where slotShiftPx = (target - start) * (draggedWidth + gap).
      const gap = 4;
      const slotShift = (targetIdx - startIdx) * (draggedWidth + gap);
      const fromX = finalDeltaX - slotShift;
      if (Math.abs(fromX) < 0.5) return;
      pill.style.transition = 'none';
      pill.style.transform = `translate3d(${fromX}px, 0, 0)`;
      pill.style.zIndex = '2';
      requestAnimationFrame(() => {
        pill.style.transition = 'transform 180ms cubic-bezier(0.2, 0.7, 0.3, 1)';
        pill.style.transform = '';
        const onEnd = () => {
          pill.style.transition = '';
          pill.style.transform = '';
          pill.style.zIndex = '';
          pill.removeEventListener('transitionend', onEnd);
          if (pendingFlipCleanup === cleanup) pendingFlipCleanup = null;
        };
        const cleanup = () => {
          pill.removeEventListener('transitionend', onEnd);
          pill.style.transition = '';
          pill.style.transform = '';
          pill.style.zIndex = '';
        };
        pendingFlipCleanup = cleanup;
        pill.addEventListener('transitionend', onEnd);
      });
    });
  }

  function tabStyle(tab: Tab, idx: number): string {
    if (dragTabId === null) return '';
    if (tab.id === dragTabId) {
      // Picked-up pill: follow the cursor. Scale + shadow give the lift.
      return [
        `transform: translate3d(${dragDeltaX}px, 0, 0) scale(1.03)`,
        'z-index: 2',
        'transition: none',
        'cursor: grabbing',
        'pointer-events: none',
        'box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18)',
      ].join('; ');
    }
    // Other pills shift to open up the landing slot.
    const start = dragStartIdx;
    const target = dragTargetIdx;
    const draggedWidth = pillRects[start]?.width ?? 0;
    const gap = 4;
    let shiftX = 0;
    if (target > start && idx > start && idx <= target) {
      shiftX = -(draggedWidth + gap);
    } else if (target < start && idx >= target && idx < start) {
      shiftX = draggedWidth + gap;
    }
    return `transform: translate3d(${shiftX}px, 0, 0); transition: transform 180ms cubic-bezier(0.2, 0.7, 0.3, 1);`;
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
<div class="tabs-strip" bind:this={stripEl} role="tablist" aria-label="Tabs" data-tauri-drag-region>
  {#if sidebarCollapsed}
    <button
      type="button"
      class="sidebar-expand-btn"
      aria-label="Expand sidebar"
      title="Expand sidebar"
      onclick={onExpandSidebar}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <polyline points="14 8 17 12 14 16" />
      </svg>
    </button>
  {/if}
  {#each tabsStore.tabs as tab, idx (tab.id)}
    <button
      type="button"
      class="tab-pill"
      class:active={tab.id === tabsStore.activeTabId}
      class:dragging={tab.id === dragTabId}
      role="tab"
      aria-selected={tab.id === tabsStore.activeTabId}
      data-tab-id={tab.id}
      style={tabStyle(tab, idx)}
      onpointerdown={(e) => onPointerDown(e, tab)}
      onpointermove={onPointerMove}
      onpointerup={(e) => onPointerUp(e, tab)}
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

<style>
  /* On macOS the strip hosts the system traffic lights, so it's sized to
     give them room: `--tabs-strip-height` (48px, set in App.svelte) seats
     the lights (top at y=20, ~12px tall) centered with margin above and
     below — Obsidian-style. On other platforms the var is unset and the
     strip falls back to 40px, simply capping the top of the editor. */
  .tabs-strip {
    flex: 0 0 auto;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: var(--tabs-strip-height, 40px);
    padding: 0 8px;
    background: var(--color-surface, var(--color-bg));
    overflow-x: auto;
    overflow-y: hidden;
    user-select: none;
    -webkit-user-select: none;
    scrollbar-width: thin;
    /* macOS: clear the traffic lights (~x 19-97) when the sidebar is
       collapsed (otherwise the sidebar provides the left clearance). */
    padding-left: 8px;
  }

  :global(.notes-shell.desktop-layout.sidebar-collapsed) .tabs-strip {
    padding-left: calc(8px + var(--macos-traffic-lights-width, 0px));
  }

  .sidebar-expand-btn {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    margin: 0 4px 2px 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--color-muted, #888);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .sidebar-expand-btn:hover {
    background: color-mix(in srgb, var(--color-bg) 70%, transparent);
    color: var(--color-text);
  }

  .sidebar-expand-btn:active {
    background: var(--color-bg);
  }

  /* Tabs sit at the bottom of the strip with rounded-top corners and a
     1px bottom margin trick that lets the active tab merge into the
     editor surface below: the active tab's background is `--color-bg`
     (matches the editor) and its `margin-bottom: -1px` covers the
     hairline between strip and editor, so the active tab visually
     "becomes" the top of the editor card. */
  .tab-pill {
    display: inline-flex;
    align-items: center;
    flex: 0 1 200px;
    min-width: 96px;
    max-width: 220px;
    height: 32px;
    margin: 0 0 -1px 0;
    padding: 0 6px 0 12px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    background: transparent;
    color: var(--color-muted, #888);
    font: inherit;
    font-size: 13px;
    line-height: 1;
    cursor: default;
    position: relative;
    text-align: left;
    white-space: nowrap;
  }

  .tab-pill:hover:not(.active) {
    background: color-mix(in srgb, var(--color-bg) 50%, transparent);
    color: var(--color-text);
  }

  .tab-pill.active {
    /* Same background as the editor body — looks like the editor
       surface "extends up" through this tab. */
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border);
    font-weight: 500;
  }

  .tab-pill.dragging {
    opacity: 0.85;
    cursor: grabbing;
  }

  .tab-title {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-right: 4px;
  }

  .tab-close-btn {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    line-height: 16px;
    text-align: center;
    border-radius: 4px;
    color: var(--color-muted, #888);
    font-size: 16px;
    opacity: 0;
    cursor: pointer;
  }

  .tab-pill:hover .tab-close-btn,
  .tab-pill.active .tab-close-btn {
    opacity: 0.7;
  }

  .tab-close-btn:hover {
    background: var(--color-border);
    opacity: 1;
    color: var(--color-text);
  }

  /* "+" button — sits at the same baseline as tab pills, smaller and
     icon-like (not styled as a tab itself). */
  .tab-new-btn {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    margin: 0 0 2px 4px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: var(--color-muted, #888);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .tab-new-btn:hover {
    background: color-mix(in srgb, var(--color-bg) 70%, transparent);
    color: var(--color-text);
  }
</style>
