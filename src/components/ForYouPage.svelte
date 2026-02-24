<script lang="ts">
  import { getAllNotes } from '$lib/notes';
  import { getEngagementData } from '$lib/engagement';
  import { getForYouNotes } from '$lib/forYou';
  import { isMobile } from '$lib/platform';
  import { navigate } from '../router';

  interface Props {
    onbrowse?: () => void;
  }

  let { onbrowse }: Props = $props();

  const notes = getAllNotes();
  const engagement = getEngagementData();
  const forYouNotes = getForYouNotes(notes, engagement);

  function formatRelativeTime(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  function handleCardClick(id: string): void {
    navigate(`/note/${encodeURIComponent(id)}`);
  }
</script>

<div class="for-you-page">
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
      {#if isMobile}
        <div class="for-you-empty-subtitle">Create your first note to get started.</div>
        <button class="for-you-browse-btn" onclick={onbrowse}>Browse notes</button>
      {:else}
        <div class="for-you-empty-subtitle">Create your first note from the sidebar to get started.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .for-you-page {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
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
    gap: 1rem;
    width: 100%;
    max-width: 720px;
    justify-content: center;
  }

  @media (max-width: 640px) {
    .for-you-cards {
      flex-direction: column;
      align-items: stretch;
    }
  }

  .for-you-card {
    width: 180px;
    height: 180px;
    flex-shrink: 0;
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
    box-shadow: 0 1px 3px rgba(28, 25, 23, 0.04);
    transition: box-shadow 0.2s ease, transform 0.2s ease, background 0.15s ease;
  }

  .for-you-card:hover {
    background: var(--color-border);
    box-shadow: 0 4px 16px rgba(28, 25, 23, 0.1);
    transform: translateY(-2px);
  }

  .for-you-card:active {
    box-shadow: 0 1px 4px rgba(28, 25, 23, 0.08);
    transform: translateY(0);
  }

  .for-you-card-title {
    font-family: var(--font-serif);
    font-size: 17px;
    color: var(--color-text);
    line-height: 1.3;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
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

  .for-you-browse-btn {
    border: none;
    border-radius: 9999px;
    padding: 0.625rem 1.25rem;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    background: var(--color-primary);
    color: var(--color-bg);
  }

  .for-you-browse-btn:active {
    opacity: 0.8;
  }
</style>
