<script lang="ts">
  import type { NotePreview } from '../types';
  import { search } from '$lib/notes';

  interface Props {
    onclose: () => void;
    onselect: (id: string) => void;
  }

  let { onclose, onselect }: Props = $props();

  let query = $state('');
  let inputEl: HTMLInputElement | undefined = $state(undefined);

  let results: NotePreview[] = $derived(search(query));

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }

  $effect(() => {
    inputEl?.focus();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div class="search-overlay" onclick={onclose} onkeydown={handleKeydown}>
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="search-panel" onclick={(e) => e.stopPropagation()}>
    <div class="search-input-row">
      <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input
        bind:this={inputEl}
        type="text"
        class="search-input"
        placeholder="Search notes..."
        bind:value={query}
      />
      {#if query}
        <button class="search-clear" aria-label="Clear search" onclick={() => { query = ''; inputEl?.focus(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      {/if}
    </div>
    <div class="search-results">
      {#each results as note (note.id)}
        <button class="search-result-item" onclick={() => onselect(note.id)}>
          <div class="search-result-title">{note.title}</div>
          {#if note.preview}
            <div class="search-result-preview">{note.preview}</div>
          {/if}
        </button>
      {:else}
        {#if query}
          <div class="search-empty">No notes found</div>
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  .search-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 200;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: max(60px, calc(40px + env(safe-area-inset-top)));
  }

  .search-panel {
    background: white;
    border-radius: 14px;
    width: min(480px, calc(100vw - 32px));
    max-height: 80vh;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .search-input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid #e8e8e8;
    flex-shrink: 0;
  }

  .search-icon {
    color: #999;
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    border: none;
    background: transparent;
    font-size: 16px;
    font-family: inherit;
    color: #1a1b26;
    outline: none;
  }

  .search-input::placeholder {
    color: #999;
  }

  .search-clear {
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: #999;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
  }

  .search-clear:active {
    background: #f0f0f0;
  }

  .search-results {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .search-result-item {
    width: 100%;
    padding: 12px 16px;
    border: none;
    border-bottom: 1px solid #f0f0f0;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
  }

  .search-result-item:active {
    background: #f5f5f5;
  }

  .search-result-item:last-child {
    border-bottom: none;
  }

  .search-result-title {
    font-size: 15px;
    font-weight: 600;
    color: #1a1b26;
    line-height: 1.3;
  }

  .search-result-preview {
    font-size: 13px;
    color: #999;
    line-height: 1.3;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-empty {
    padding: 24px 16px;
    text-align: center;
    color: #999;
    font-size: 14px;
  }
</style>
