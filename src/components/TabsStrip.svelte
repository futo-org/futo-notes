<script lang="ts">
  import { getContext } from 'svelte';
  import { tabsStore, type Tab } from '$lib/tabsStore.svelte';
  import { APP_CONTEXT_KEY, type AppContext } from '$lib/appContext.svelte';
  import { idLeaf } from '$lib/platform/pathSafety';

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

<div class="tabs-strip" bind:this={stripEl} role="tablist" aria-label="Tabs">
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
        }}
      >×</span>
    </button>
  {/each}
  <button
    type="button"
    class="tab-new-btn"
    aria-label="New tab"
    title="New tab"
    onclick={onNewTabClick}
  >+</button>
</div>

<style>
  .tabs-strip {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 36px;
    padding: 0 6px;
    background: var(--color-surface, var(--color-bg));
    border-bottom: 1px solid var(--color-border);
    overflow-x: auto;
    overflow-y: hidden;
    user-select: none;
    -webkit-user-select: none;
    scrollbar-width: thin;
  }

  .tab-pill {
    display: inline-flex;
    align-items: center;
    flex: 0 1 200px;
    min-width: 96px;
    max-width: 220px;
    height: 26px;
    margin: 0;
    padding: 0 6px 0 12px;
    border: 1px solid transparent;
    border-radius: 13px;
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

  .tab-pill:hover {
    background: color-mix(in srgb, var(--color-bg) 60%, transparent);
    color: var(--color-text);
  }

  .tab-pill.active {
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border);
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

  .tab-new-btn {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    margin: 0 0 0 2px;
    border-radius: 13px;
    border: none;
    background: transparent;
    color: var(--color-muted, #888);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .tab-new-btn:hover {
    background: var(--color-surface);
    color: var(--color-text);
  }
</style>
