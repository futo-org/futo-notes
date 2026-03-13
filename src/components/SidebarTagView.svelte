<script lang="ts">
  import type { NotePreview } from '../types';
  import { getSortedTags, getNotesForTag } from '$lib/tags';

  interface Props {
    notes: NotePreview[];
    selectedId: string | null;
    onselect: (id: string) => void;
  }

  let { notes, selectedId, onselect }: Props = $props();

  let openTags = $state(new Set<string>());

  let sortedTags = $derived(getSortedTags(notes));

  function toggleTag(tag: string) {
    const next = new Set(openTags);
    if (next.has(tag)) {
      next.delete(tag);
    } else {
      next.add(tag);
    }
    openTags = next;
  }

  function getTagNotes(tag: string): NotePreview[] {
    return getNotesForTag(notes, tag)
      .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  }
</script>

<div class="sidebar-tag-view">
  {#if sortedTags.length === 0}
    <div class="sidebar-tag-empty">No tags yet</div>
  {:else}
    {#each sortedTags as { tag, display, count }}
      <div class="sidebar-tag-row">
        <button class="sidebar-tag-header" onclick={() => toggleTag(tag)}>
          <span>#{display}</span>
          <span class="sidebar-tag-count">{count}</span>
        </button>
        {#if openTags.has(tag)}
          <div class="sidebar-tag-notes">
            {#each getTagNotes(tag) as note}
              <button
                class="sidebar-tag-note"
                class:active={note.id === selectedId}
                onclick={() => onselect(note.id)}
              >
                {note.title}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
