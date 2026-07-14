<script lang="ts">
  import type { NotePreview } from '$shared/types/note';
  import { getForYouNotes } from './forYou';
  import { formatRelativeTime } from '$shared/time/formatRelativeTime';

  interface Props {
    notes: NotePreview[];
    onnavigate: (id: string) => void;
  }

  let { notes, onnavigate }: Props = $props();
  const forYouNotes = $derived(getForYouNotes(notes));

  function handleCardClick(id: string): void {
    onnavigate(id);
  }
</script>

<div class="for-you-page">
  <div class="for-you-content">
    {#if forYouNotes.length > 0}
      <div class="for-you-header">For You</div>
      <div class="for-you-cards">
        {#each forYouNotes as note (note.id)}
          <button class="for-you-card" onclick={() => handleCardClick(note.id)}>
            <div class="for-you-card-title">{note.title}</div>
            {#if note.preview}
              <div class="for-you-card-preview">{note.preview.slice(0, 60)}</div>
            {/if}
            <div class="for-you-card-time">{formatRelativeTime(note.modificationTime)}</div>
          </button>
        {/each}
      </div>
    {:else}
      <div class="for-you-empty">
        <div class="for-you-empty-title">FUTO Notes</div>
        <div class="for-you-empty-subtitle">
          Create your first note from the sidebar to get started.
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .for-you-page {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    min-height: 100%;
    padding: 2rem 1.25rem 1.25rem;
    padding-bottom: max(1.25rem, calc(1.25rem + env(safe-area-inset-bottom, 0px)));
    gap: 1rem;
    box-sizing: border-box;
  }

  .for-you-content {
    width: 100%;
    max-width: 680px;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
  }

  .for-you-header {
    font-family: var(--font-serif);
    font-size: 24px;
    color: var(--color-text);
    letter-spacing: -0.01em;
  }

  .for-you-cards {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    justify-content: center;
  }

  .for-you-card {
    width: 180px;
    height: 180px;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 1rem;
    border-radius: 12px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(var(--ink-rgb), 0.04);
    transition:
      box-shadow 0.2s ease,
      transform 0.2s ease,
      background 0.15s ease;
  }

  @media (hover: hover) {
    .for-you-card:hover {
      background: var(--color-border);
      box-shadow: 0 4px 16px rgba(var(--ink-rgb), 0.1);
      transform: translateY(-2px);
    }
  }

  .for-you-card:active {
    box-shadow: 0 1px 4px rgba(var(--ink-rgb), 0.08);
    transform: translateY(0);
  }

  .for-you-card-title {
    font-family: var(--font-serif);
    font-size: 17px;
    font-weight: 700;
    color: var(--color-text);
    line-height: 1.3;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .for-you-card-preview {
    flex: 1;
    min-height: 0;
    font-size: 13px;
    color: var(--color-muted);
    line-height: 1.4;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  .for-you-card-time {
    font-size: 12px;
    color: var(--color-muted);
    opacity: 0.7;
  }

  .for-you-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    text-align: center;
  }

  .for-you-empty-title {
    font-family: var(--font-serif);
    font-size: 24px;
    color: var(--color-border);
    letter-spacing: -0.01em;
  }

  .for-you-empty-subtitle {
    font-size: 14px;
    color: var(--color-muted);
  }
</style>
