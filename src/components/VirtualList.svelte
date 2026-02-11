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
    onselect
  }: Props = $props();

  let pressedId: string | null = $state(null);
  let pendingSelect: string | null = null;

  // Cancel any pending press/selection when a drawer swipe begins
  $effect(() => {
    if (isDragging) {
      pressedId = null;
      pendingSelect = null;
    }
  });

  function handleTouchStart(id: string, event: TouchEvent): void {
    if (isDragging) return;
    pressedId = id;
  }

  function handleTouchEnd(id: string): void {
    if (isDragging) { pressedId = null; pendingSelect = null; return; }
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

<div class="notes-list-scroll">
  {#each items as note (note.id)}
    <button
      class="note-item"
      class:selected={note.id === selectedId}
      class:pressed={note.id === pressedId}
      ontouchstart={(e) => handleTouchStart(note.id, e)}
      ontouchend={() => handleTouchEnd(note.id)}
      ontouchcancel={handleTouchCancel}
      ontouchmove={handleTouchMove}
    >
      {#if showPreview}
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-base mb-1 overflow-hidden text-ellipsis whitespace-nowrap">{note.title}</div>
          <div class="note-preview text-sm text-muted overflow-hidden text-ellipsis line-clamp-2">{note.preview}</div>
        </div>
      {:else}
        <div class="note-title font-semibold text-base overflow-hidden text-ellipsis whitespace-nowrap">{note.title}</div>
      {/if}
    </button>
  {:else}
    <div class="flex items-center justify-center h-full text-base text-gray-400 text-center p-8">No notes yet. Tap + to create one.</div>
  {/each}
</div>
