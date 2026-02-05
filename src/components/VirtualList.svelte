<script lang="ts">
  import type { NotePreview } from '../types';

  interface Props {
    items: NotePreview[];
    selectedId?: string | null;
    showPreview?: boolean;
    onselect?: (id: string) => void;
  }

  let {
    items,
    selectedId = null,
    showPreview = false,
    onselect
  }: Props = $props();

  let pressedId: string | null = $state(null);
  let pendingSelect: string | null = null;

  function handleTouchStart(id: string, event: TouchEvent): void {
    // Prevent if this touch is part of a scroll
    pressedId = id;
  }

  function handleTouchEnd(id: string): void {
    if (pressedId === id) {
      // Item was tapped (not scrolled away)
      pendingSelect = id;
      // Small delay to show the pressed state before navigation
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
    // User is scrolling, cancel the press
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
        <div class="note-content">
          <div class="note-title">{note.title}</div>
          <div class="note-preview">{note.preview}</div>
        </div>
      {:else}
        <div class="note-title">{note.title}</div>
      {/if}
    </button>
  {:else}
    <div class="empty">No notes yet. Tap + to create one.</div>
  {/each}
</div>
