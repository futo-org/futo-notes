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

  // getNotesForTag + sort is O(n log n) per call. Without a cache,
  // {#each getTagNotes(tag)} reran on every reactive cycle (which
  // includes every save). Cache results keyed by the current `notes`
  // array identity so opening one tag doesn't re-cost others, and so
  // typing in an unrelated note doesn't redo the sort.
  // A fresh Map per `notes` identity. Must NOT be the old $state-cacheKey
  // + $effect pattern: `notes` is a raw array ($state.raw upstream), and
  // storing it in deeply-reactive $state proxies it, so the identity guard
  // never held and the effect re-triggered itself until Svelte threw
  // effect_update_depth_exceeded (bricking all reactivity until reload).
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
    const computed = getNotesForTag(notes, tag)
      .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
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
