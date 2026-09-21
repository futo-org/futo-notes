<script lang="ts">
  /*
   * The desktop find bar — a Firefox-style strip docked over the bottom of the
   * editor's own scrolling pane (docs/spec/editor.md "Find in note").
   *
   * Replaces the CodeMirror `showPanel` bar deleted with that engine. It is
   * mounted only when `resolveFindPanel` says so, i.e. never under a native
   * shell: iOS and Android render their own SwiftUI/Compose bars and drive the
   * same engine through the bridge.
   *
   * The bar OWNS no find logic. It forwards query/step/close and renders the
   * engine's `label` verbatim, exactly as the two native bars do.
   */
  import { ChevronDown, ChevronUp, X } from '@lucide/svelte';

  import { localizedText } from '$shared/localization';

  interface Props {
    query: string;
    /** The engine's own "N of M" wording; never recomputed here. */
    label: string;
    hasMatches: boolean;
    /** Bumped by every open, including one that finds the bar already up. */
    focusToken: number;
    onquery: (query: string) => void;
    onstep: (direction: 1 | -1) => void;
    onclose: () => void;
    /** The bar's rendered height, so the engine can keep a match clear of it. */
    onheight: (px: number) => void;
  }

  let { query, label, hasMatches, focusToken, onquery, onstep, onclose, onheight }: Props =
    $props();

  let input: HTMLInputElement | undefined = $state();
  let bar: HTMLElement | undefined = $state();

  /* Ctrl/Cmd+F with the bar ALREADY open refocuses and selects the query
   * (docs/spec/editor.md), so this keys off the token rather than off mount.
   *
   * The token's VALUE has to be compared, not merely read. The shell hands
   * these props down from one `$state` object that is replaced on every engine
   * report — including the one an edit in the note body produces — so the
   * effect re-runs on each report with the token unchanged. Focusing there took
   * the keyboard away from the person typing: the first character reached the
   * note and the rest went into the query field. */
  let focusedToken = -1;
  $effect(() => {
    const token = focusToken;
    if (token === focusedToken) return;
    focusedToken = token;
    input?.focus();
    input?.select();
  });

  /* The engine's scroll margin is this element's height. Measured rather than
   * hardcoded: the bar grows with the user's font settings, and a stale number
   * would put the current match back under it. */
  $effect(() => {
    const element = bar;
    if (!element) return;
    const report = (): void => onheight(element.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      onstep(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
    }
  }
</script>

<div class="futo-find-panel" bind:this={bar}>
  <input
    class="futo-find-query"
    bind:this={input}
    type="text"
    value={query}
    placeholder={localizedText('editor.find.queryHint')}
    aria-label={localizedText('editor.find.queryLabel')}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    oninput={(event) => onquery(event.currentTarget.value)}
    onkeydown={handleKeydown}
  />
  <span class="futo-find-count" class:is-empty={!hasMatches} aria-live="polite">{label}</span>
  <button
    class="futo-find-button"
    type="button"
    disabled={!hasMatches}
    aria-label={localizedText('editor.find.previousMatch')}
    onclick={() => onstep(-1)}><ChevronUp size={16} strokeWidth={2.25} /></button
  >
  <button
    class="futo-find-button"
    type="button"
    disabled={!hasMatches}
    aria-label={localizedText('editor.find.nextMatch')}
    onclick={() => onstep(1)}><ChevronDown size={16} strokeWidth={2.25} /></button
  >
  <button
    class="futo-find-button"
    type="button"
    aria-label={localizedText('editor.find.close')}
    onclick={onclose}><X size={16} strokeWidth={2.25} /></button
  >
</div>

<style>
  /* `sticky`, not `absolute`: the bar has to stay docked at the bottom of the
     note pane while the note scrolls underneath it, and the pane — not this
     component — is the scroll container. */
  .futo-find-panel {
    position: sticky;
    bottom: 0;
    z-index: 5;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .futo-find-query {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 13px;
    color: var(--color-text);
    background: var(--color-bg);
  }

  .futo-find-query:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .futo-find-count {
    flex: none;
    min-width: 5ch;
    text-align: right;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--color-muted);
  }

  .futo-find-count.is-empty {
    color: var(--color-danger);
  }

  .futo-find-button {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    cursor: pointer;
  }

  .futo-find-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .futo-find-button:not(:disabled):hover {
    background: var(--color-surface);
  }
</style>
