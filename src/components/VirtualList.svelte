<script lang="ts">
  import type { NotePreview } from '../types';

  interface Props {
    items: NotePreview[];
    selectedId?: string | null;
    showPreview?: boolean;
    isDragging?: boolean;
    onselect?: (id: string) => void;
  }

  let {
    items,
    selectedId = null,
    showPreview = false,
    isDragging = false,
    onselect,
  }: Props = $props();

  const ITEM_HEIGHT = 48;
  const BUFFER = 5;

  let scrollTop = $state(0);
  let containerHeight = $state(0);
  let containerEl: HTMLDivElement | undefined = $state();
  let pressedId: string | null = $state(null);
  let pendingSelect: string | null = null;

  let totalHeight = $derived(items.length * ITEM_HEIGHT);

  let visibleRange = $derived.by(() => {
    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
    const end = Math.min(
      items.length,
      Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + BUFFER,
    );
    return { start, end };
  });

  let visibleItems = $derived(
    items.slice(visibleRange.start, visibleRange.end).map((note, i) => ({
      note,
      index: visibleRange.start + i,
    })),
  );

  // Track container size with ResizeObserver
  $effect(() => {
    const el = containerEl;
    if (!el) return;

    containerHeight = el.clientHeight;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerHeight = entry.contentRect.height;
      }
    });
    observer.observe(el);

    return () => observer.disconnect();
  });

  // Cancel any pending press/selection when a drawer swipe begins
  $effect(() => {
    if (isDragging) {
      pressedId = null;
      pendingSelect = null;
    }
  });

  function handleScroll(event: Event): void {
    const target = event.currentTarget as HTMLDivElement;
    scrollTop = target.scrollTop;
  }

  // Track whether a touch sequence is active so we can suppress the synthetic click
  let touchHandled = false;

  function handleTouchStart(id: string, event: TouchEvent): void {
    if (isDragging) return;
    pressedId = id;
    touchHandled = false;
  }

  function handleTouchEnd(id: string): void {
    if (isDragging) {
      pressedId = null;
      pendingSelect = null;
      return;
    }
    touchHandled = true;
    if (pressedId === id) {
      pendingSelect = id;
      setTimeout(() => {
        pressedId = null;
        if (pendingSelect === id) {
          onselect?.(id);
          pendingSelect = null;
        }
      }, 80);
    } else {
      pressedId = null;
    }
  }

  function handleTouchCancel(): void {
    pressedId = null;
    pendingSelect = null;
  }

  function handleTouchMove(): void {
    pressedId = null;
    pendingSelect = null;
  }
</script>

<div bind:this={containerEl} class="notes-list-scroll" onscroll={handleScroll}>
  {#if items.length === 0}
    <div class="flex items-center justify-center h-full text-base text-gray-400 text-center p-8">
      No notes yet. Tap + to create one.
    </div>
  {:else}
    <div style="height: {totalHeight}px; position: relative;">
      {#each visibleItems as { note, index } (note.id)}
        <button
          class="note-item"
          class:selected={note.id === selectedId}
          class:pressed={note.id === pressedId}
          style="position: absolute; top: {index * ITEM_HEIGHT}px; width: 100%;"
          onclick={() => {
            if (!touchHandled) onselect?.(note.id);
            touchHandled = false;
          }}
          ontouchstart={(e) => handleTouchStart(note.id, e)}
          ontouchend={() => handleTouchEnd(note.id)}
          ontouchcancel={handleTouchCancel}
          ontouchmove={handleTouchMove}
        >
          {#if showPreview}
            <div class="flex-1 min-w-0">
              <div
                class="font-semibold text-base mb-1 overflow-hidden text-ellipsis whitespace-nowrap"
              >
                {note.title}
              </div>
              <div
                class="note-preview text-sm text-muted overflow-hidden text-ellipsis line-clamp-2"
              >
                {note.preview}
              </div>
            </div>
          {:else}
            <div
              class="note-title font-semibold text-base overflow-hidden text-ellipsis whitespace-nowrap"
            >
              {note.title}
            </div>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
