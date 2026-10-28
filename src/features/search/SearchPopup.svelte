<script lang="ts">
  import { Search, X } from '@lucide/svelte';
  import { onDestroy, tick } from 'svelte';
  import type { NotePreview } from '$shared/types/note';
  import { search } from '$features/notes/notes.svelte';
  import { dismissable } from '$shared/dialogs/dismissable';
  import { localizedText } from '$shared/localization';
  import { idLeaf, idParent } from '$lib/platform/pathSafety';
  import { isSearchPopupFindShortcut } from './searchPopupShortcuts';
  import {
    puppetModalScope,
    puppetRefusal,
    puppetVerb,
    registerPuppetVerbs,
  } from '$app/puppet/puppetRegistry';

  interface Props {
    onclose: () => void;
    onselect: (id: string, event?: MouseEvent) => void;
  }

  let { onclose, onselect }: Props = $props();

  let query = $state('');
  let inputEl: HTMLInputElement | undefined = $state(undefined);
  let selectedIndex = $state(-1);
  let resultEls: HTMLElement[] = $state([]);

  let results: NotePreview[] = $state([]);
  // The query `results` answers, and the puppet receipts waiting for the next answer.
  let resultsQuery: string | null = null;
  let resultWaiters: Array<() => void> = [];

  function showResults(forQuery: string, rows: NotePreview[]): void {
    results = rows;
    resultsQuery = forQuery;
    // Only the latest query's results are ever shown, so every waiter is answered by them.
    const waiting = resultWaiters;
    resultWaiters = [];
    if (waiting.length > 0) void tick().then(() => waiting.forEach((resolve) => resolve()));
  }

  onDestroy(() => resultWaiters.forEach((resolve) => resolve()));

  /** Types a query; the verb's receipt waits until its results are on screen. */
  function setQueryAndWait(next: string): Promise<void> | undefined {
    query = next;
    if (resultsQuery === next) return undefined;
    return new Promise((resolve) => resultWaiters.push(resolve));
  }

  let keywordRequestId = 0;

  // The overlay covers the window: a click behind it only closes it.
  puppetModalScope();
  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb(
        'SetSearchQuery',
        { query: 'string' },
        (args) => setQueryAndWait(args.query as string),
        { controls: ['search.placeholder'] },
      ),
      puppetVerb(
        'ClearSearchQuery',
        {},
        () => {
          inputEl?.focus();
          return setQueryAndWait('');
        },
        { controls: ['search.clearAccessibilityLabel'] },
      ),
      puppetVerb('StepSearchResult', { direction: 'integer' }, (args) => {
        const direction = args.direction;
        if (direction !== 1 && direction !== -1) {
          return puppetRefusal(400, 'direction must be 1 or -1');
        }
        selectedIndex =
          direction === 1
            ? Math.min(selectedIndex + 1, results.length - 1)
            : Math.max(selectedIndex - 1, -1);
        return undefined;
      }),
      // No index: the highlighted result, as Enter would.
      puppetVerb(
        'OpenSearchResult',
        { index: 'integer?' },
        (args) => {
          const index = (args.index as number | undefined) ?? selectedIndex;
          const result = results[index];
          if (!result) {
            return puppetRefusal(409, `no result at ${index} (${results.length} results)`);
          }
          onselect(result.id);
          return undefined;
        },
        { controlsMatching: '.search-result-item' },
      ),
      puppetVerb('CloseSearch', {}, onclose),
    ]),
  );

  // Debounced keyword search through the Rust-owned local-note store.
  $effect(() => {
    const q = query;
    const requestId = ++keywordRequestId;

    if (!q.trim()) {
      search('')
        .then((r) => {
          // Empty query shows the 8 most-recent notes (search.md), not the
          // whole vault — search('') returns all notes most-recent-first.
          if (requestId === keywordRequestId) showResults(q, r.slice(0, 8));
        })
        .catch(() => {
          if (requestId === keywordRequestId) showResults(q, []);
        });
      return;
    }

    const timer = setTimeout(() => {
      search(q)
        .then((r) => {
          if (requestId === keywordRequestId && q === query) showResults(q, r);
        })
        .catch(() => {
          if (requestId === keywordRequestId && q === query) showResults(q, []);
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

  // Escape is not handled here: the shared dialog stack (use:dismissable on the
  // overlay) closes the top-most overlay wherever focus happens to be.
  function handleKeydown(event: KeyboardEvent): void {
    if (isSearchPopupFindShortcut(event)) {
      // This popup owns the active text-entry surface. Claim the chord so the
      // window shortcuts cannot drive the note's find bar behind the overlay.
      event.preventDefault();
      event.stopPropagation();
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
      onselect(results[selectedIndex].id);
      return;
    }
  }

  $effect(() => {
    inputEl?.focus();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="search-overlay"
  data-puppet-surface="dialog"
  use:dismissable={{ ondismiss: onclose }}
  onclick={onclose}
>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="search-panel" onclick={(e) => e.stopPropagation()} onkeydown={handleKeydown}>
    <div class="search-input-row">
      <Search class="search-icon" size={20} />
      <input
        bind:this={inputEl}
        type="text"
        class="search-input"
        placeholder={localizedText('search.placeholder')}
        bind:value={query}
      />
      {#if query}
        <button
          class="search-clear"
          aria-label={localizedText('search.clearAccessibilityLabel')}
          onclick={() => {
            query = '';
            inputEl?.focus();
          }}
        >
          <X size={18} />
        </button>
      {/if}
    </div>

    <div class="search-results">
      {#each results as result, i (result.id)}
        <button
          class="search-result-item"
          class:selected={i === selectedIndex}
          data-note-id={result.id}
          bind:this={resultEls[i]}
          onclick={(e) => onselect(result.id, e)}
          onauxclick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onselect(result.id, e);
            }
          }}
          onpointerenter={() => {
            selectedIndex = i;
          }}
        >
          <div class="search-result-title">
            <span class="search-result-leaf">{idLeaf(result.title)}</span>
            {#if result.id.includes('/')}
              {@const parent = idLeaf(idParent(result.id))}
              <span class="search-result-folder-badge" data-testid="folder-badge">{parent}</span>
            {/if}
          </div>
          {#if result.preview}
            <div class="search-result-preview">{result.preview}</div>
          {/if}
        </button>
      {:else}
        {#if query}
          <div class="search-empty">{localizedText('search.noNotesFound')}</div>
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
    z-index: var(--z-overlay);
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
    box-shadow:
      0 16px 48px rgba(var(--ink-rgb), 0.2),
      0 0 0 1px rgba(var(--ink-rgb), 0.05);
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

  :global(.search-icon) {
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

  .search-results {
    overflow-y: auto;
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

  .search-result-preview {
    font-size: 13px;
    color: var(--color-muted);
    line-height: 1.3;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-empty {
    padding: 24px 16px;
    text-align: center;
    color: var(--color-muted);
    font-size: 14px;
  }
</style>
