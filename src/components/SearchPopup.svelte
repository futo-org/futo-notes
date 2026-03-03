<script lang="ts">
  import type { SearchResultItem } from '../types';
  import { searchKeyword, searchWithVectors, type SearchTimingResult } from '$lib/notes';

  interface Props {
    onclose: () => void;
    onselect: (id: string) => void;
  }

  let { onclose, onselect }: Props = $props();

  let query = $state('');
  let inputEl: HTMLInputElement | undefined = $state(undefined);
  let selectedIndex = $state(-1);
  let resultEls: HTMLElement[] = $state([]);
  let vectorResults: SearchTimingResult | null = $state(null);
  let vectorSearching = $state(false);

  let keywordResults: SearchResultItem[] = $state([]);
  let results: SearchResultItem[] = $derived(
    !query.trim()
      ? keywordResults
      : (vectorResults ? vectorResults.results : keywordResults)
  );
  let timing = $derived(vectorResults?.timing ?? null);

  let keywordRequestId = 0;

  // Debounced keyword search — instant results
  $effect(() => {
    const q = query;
    const requestId = ++keywordRequestId;

    if (!q.trim()) {
      searchKeyword('')
        .then((results) => {
          if (requestId === keywordRequestId) {
            keywordResults = results;
          }
        })
        .catch(() => {
          if (requestId === keywordRequestId) {
            keywordResults = [];
          }
        });
      return;
    }

    const timer = setTimeout(() => {
      searchKeyword(q)
        .then((results) => {
          if (requestId === keywordRequestId && q === query) {
            keywordResults = results;
          }
        })
        .catch(() => {
          if (requestId === keywordRequestId && q === query) {
            keywordResults = [];
          }
        });
    }, 100);

    return () => clearTimeout(timer);
  });

  // Debounced unified search (keyword + vector with 300ms deadline)
  let vectorDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let vectorAbortController: AbortController | null = null;

  $effect(() => {
    const q = query;

    vectorSearching = false;

    if (vectorDebounceTimer) clearTimeout(vectorDebounceTimer);
    if (vectorAbortController) {
      vectorAbortController.abort();
      vectorAbortController = null;
    }

    if (!q.trim()) {
      vectorResults = null;
      return;
    }

    vectorDebounceTimer = setTimeout(async () => {
      if (q !== query) return;

      const controller = new AbortController();
      vectorAbortController = controller;
      vectorSearching = true;
      try {
        const result = await searchWithVectors(q, controller.signal);
        if (q === query) {
          vectorResults = result;
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (q === query) vectorResults = null;
      } finally {
        if (vectorAbortController === controller) {
          vectorAbortController = null;
        }
        if (q === query) vectorSearching = false;
      }
    }, 150);
  });

  // Reset selection when results change
  $effect(() => {
    results; // track
    selectedIndex = -1;
  });

  // Scroll selected item into view
  $effect(() => {
    if (selectedIndex >= 0 && resultEls[selectedIndex]) {
      resultEls[selectedIndex].scrollIntoView({ block: 'nearest' });
    }
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, -1);
      return;
    }
    if (event.key === 'Enter' && selectedIndex >= 0 && results[selectedIndex]) {
      event.preventDefault();
      onselect(results[selectedIndex].note.id);
      return;
    }
  }

  function formatMs(ms: number): string {
    return ms < 1 ? '<1ms' : `${Math.round(ms)}ms`;
  }

  $effect(() => {
    inputEl?.focus();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div class="search-overlay" onclick={onclose}>
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="search-panel" onclick={(e) => e.stopPropagation()} onkeydown={handleKeydown}>
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
      {#if vectorSearching}
        <span class="search-vector-indicator" title="Searching with AI..."></span>
      {:else if vectorResults && query}
        <span class="search-vector-done" title="AI-enhanced results"></span>
      {/if}
      {#if query}
        <button class="search-clear" aria-label="Clear search" onclick={() => { query = ''; inputEl?.focus(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      {/if}
    </div>

    {#if timing && query}
      <div class="search-timing-row">
        <span class="search-timing">
          {#if timing.embed > 0}embed: {formatMs(timing.embed)} | {/if}search: {formatMs(timing.keyword + timing.vector)} | total: {formatMs(timing.total)}
        </span>
      </div>
    {/if}

    <div class="search-results">
      {#each results as result, i (result.note.id)}
        <button
          class="search-result-item"
          class:selected={i === selectedIndex}
          bind:this={resultEls[i]}
          onclick={() => onselect(result.note.id)}
          onpointerenter={() => { selectedIndex = i; }}
        >
          <div class="search-result-title">
            {result.note.title}
            {#if result.source === 'keyword'}
              <span class="source-badge source-keyword" title="Keyword match">K</span>
            {:else if result.source === 'vector'}
              <span class="source-badge source-vector" title="Vector match">V</span>
            {:else if result.source === 'both'}
              <span class="source-badge source-both" title="Keyword + Vector match">K+V</span>
            {/if}
          </div>
          {#if result.snippet && result.snippet.length > 0}
            <div class="search-result-preview">
              {#each result.snippet as segment}
                {#if segment.highlight}
                  <mark class="search-highlight">{segment.text}</mark>
                {:else}
                  {segment.text}
                {/if}
              {/each}
            </div>
          {:else if result.note.preview}
            <div class="search-result-preview">{result.note.preview}</div>
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
    background: rgba(var(--ink-rgb), 0.35);
    z-index: 200;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: max(60px, calc(40px + env(safe-area-inset-top)));
  }

  .search-panel {
    background: var(--color-bg);
    border-radius: 16px;
    width: min(480px, calc(100vw - 32px));
    max-height: 80vh;
    box-shadow: 0 16px 48px rgba(var(--ink-rgb), 0.2), 0 0 0 1px rgba(var(--ink-rgb), 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .search-input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .search-icon {
    color: var(--color-muted);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    border: none;
    background: transparent;
    font-size: 16px;
    font-family: inherit;
    color: var(--color-text);
    outline: none;
  }

  .search-input::placeholder {
    color: var(--color-muted);
  }

  .search-clear {
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
  }

  .search-clear:active {
    background: rgba(var(--ink-rgb), 0.06);
  }

  .search-timing-row {
    display: flex;
    align-items: center;
    padding: 6px 16px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .search-timing {
    margin-left: auto;
    font-size: 11px;
    color: var(--color-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .search-results {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .search-result-item {
    width: 100%;
    padding: 12px 16px;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
  }

  .search-result-item:active {
    background: rgba(var(--ink-rgb), 0.04);
  }

  .search-result-item.selected {
    background: rgba(var(--primary-rgb), 0.08);
  }

  .search-result-item:last-child {
    border-bottom: none;
  }

  .search-result-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.3;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .source-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 4px;
    border-radius: 3px;
    line-height: 1.2;
    flex-shrink: 0;
  }

  .source-keyword {
    background: rgba(59, 130, 246, 0.12);
    color: rgb(59, 130, 246);
  }

  .source-vector {
    background: rgba(168, 85, 247, 0.12);
    color: rgb(168, 85, 247);
  }

  .source-both {
    background: rgba(34, 197, 94, 0.12);
    color: rgb(34, 197, 94);
  }

  .search-result-preview {
    font-size: 13px;
    color: var(--color-muted);
    line-height: 1.3;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-highlight {
    background: rgba(var(--primary-rgb), 0.15);
    border-radius: 2px;
    padding: 0 1px;
    color: var(--color-primary-hover);
  }

  .search-vector-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-primary);
    opacity: 0.6;
    flex-shrink: 0;
    animation: pulse 1s ease-in-out infinite;
  }

  .search-vector-done {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-primary);
    opacity: 0.4;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 0.8; }
  }

  .search-empty {
    padding: 24px 16px;
    text-align: center;
    color: var(--color-muted);
    font-size: 14px;
  }
</style>
