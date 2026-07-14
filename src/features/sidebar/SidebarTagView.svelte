<script lang="ts">
  import type { NotePreview } from '$shared/types/note';
  import { getSortedTags, getNotesForTag } from '$features/tags/noteTags';

  interface Props {
    notes: NotePreview[];
    selectedId: string | null;
    onselect: (id: string) => void;
  }

  let { notes, selectedId, onselect }: Props = $props();

  let openTags = $state(new Set<string>());

  let sortedTags = $derived(getSortedTags(notes));

  const tagNotesCache = $derived.by(() => {
    void notes;
    return new Map<string, NotePreview[]>();
  });

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
    const cached = tagNotesCache.get(tag);
    if (cached) return cached;
    const computed = getNotesForTag(notes, tag).sort((a, b) =>
      a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
    );
    tagNotesCache.set(tag, computed);
    return computed;
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
