<script lang="ts">
  import type { SearchResultItem } from '../types';
  import { searchKeyword } from '$lib/notes.svelte';
  import { shouldPreventScrollChaining } from '$lib/touchScrollContain';

  interface Props {
    onclose: () => void;
    onselect: (id: string) => void;
  }

  let { onclose, onselect }: Props = $props();

  let query = $state('');
  let overlayEl: HTMLDivElement | undefined = $state(undefined);
  let inputEl: HTMLInputElement | undefined = $state(undefined);
  let selectedIndex = $state(-1);
  let resultEls: HTMLElement[] = $state([]);
  let lastTouchY = 0;

  let results: SearchResultItem[] = $state([]);

  let keywordRequestId = 0;

  // Debounced keyword search — instant local results via MiniSearch
  $effect(() => {
    const q = query;
    const requestId = ++keywordRequestId;

    if (!q.trim()) {
      searchKeyword('')
        .then((r) => {
          if (requestId === keywordRequestId) results = r;
        })
        .catch(() => {
          if (requestId === keywordRequestId) results = [];
        });
      return;
    }

    const timer = setTimeout(() => {
      searchKeyword(q)
        .then((r) => {
          if (requestId === keywordRequestId && q === query) results = r;
        })
        .catch(() => {
          if (requestId === keywordRequestId && q === query) results = [];
        });
    }, 100);

    return () => clearTimeout(timer);
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

  function handleOverlayKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }

  function resetViewportScroll(): void {
    if (window.scrollY === 0 && document.documentElement.scrollTop === 0 && document.body.scrollTop === 0) return;
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function handleSearchTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    lastTouchY = event.touches[0].clientY;
  }

  function handleSearchTouchMove(event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    const y = event.touches[0].clientY;
    const dy = y - lastTouchY;
    lastTouchY = y;

    const target = event.target instanceof Element ? event.target : null;
    const scroller = target?.closest('.search-results') as HTMLElement | null;
    if (!scroller) {
      event.preventDefault();
      resetViewportScroll();
      return;
    }

    if (shouldPreventScrollChaining(scroller, dy)) {
      event.preventDefault();
      resetViewportScroll();
    }
  }

  $effect(() => {
    const overlay = overlayEl;
    if (!overlay) return;

    resetViewportScroll();
    overlay.addEventListener('touchstart', handleSearchTouchStart, { passive: true });
    overlay.addEventListener('touchmove', handleSearchTouchMove, { passive: false });
    window.addEventListener('scroll', resetViewportScroll, { passive: true });
    return () => {
      overlay.removeEventListener('touchstart', handleSearchTouchStart);
      overlay.removeEventListener('touchmove', handleSearchTouchMove);
      window.removeEventListener('scroll', resetViewportScroll);
    };
  });

  $effect(() => {
    resetViewportScroll();
    inputEl?.focus();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={overlayEl} class="search-overlay" onclick={onclose} onkeydown={handleOverlayKeydown}>
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
      {#each results as result, i (result.note.id)}
        <button
          class="search-result-item"
          class:selected={i === selectedIndex}
          bind:this={resultEls[i]}
          onclick={() => onselect(result.note.id)}
          onpointerenter={() => { selectedIndex = i; }}
        >
          <div class="search-result-title">
            <span class="search-result-leaf">{result.note.title.split('/').pop()}</span>
            {#if result.note.id.includes('/')}
              {@const parent = result.note.id.split('/').slice(-2, -1)[0]}
              <span class="search-result-folder-badge" data-testid="folder-badge">{parent}</span>
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
    /* iOS WKWebView: when the list has nothing (or little) to scroll
       and the keyboard is up, a touchmove here would otherwise pan the
       visual viewport and drag the whole app behind the popup. */
    overscroll-behavior: contain;
    touch-action: pan-y;
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

  .search-result-leaf {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /** Folder-membership badge — shows the immediate parent folder of a
   *  note returned by search. Per spec §UI/Search the older "outside
   *  the main vault" wording is gone; this is now a flat badge that
   *  applies to any note inside any folder. */
  .search-result-folder-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
    line-height: 1.2;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--color-muted, #888) 15%, transparent);
    color: var(--color-muted, #555);
    text-transform: none;
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
    background: color-mix(in srgb, var(--badge-keyword) 12%, transparent);
    color: var(--badge-keyword);
  }

  .source-vector {
    background: color-mix(in srgb, var(--badge-vector) 12%, transparent);
    color: var(--badge-vector);
  }

  .source-both {
    background: color-mix(in srgb, var(--badge-both) 12%, transparent);
    color: var(--badge-both);
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
