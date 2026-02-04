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
</script>

<div class="notes-list-scroll">
  {#each items as note (note.id)}
    <button
      class="note-item"
      class:selected={note.id === selectedId}
      onclick={() => onselect?.(note.id)}
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
