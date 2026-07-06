<script lang="ts">
  interface Props {
    statusMessage: string;
    indicatorVisible: boolean;
    offline: boolean;
    /** F15: last auto/background sync attempt failed (cleared on next success). */
    error?: boolean;
    /** Human-readable error shown in the indicator's hover tooltip. */
    errorMessage?: string;
    /** Live SSE stream connected + healthy → show the subtle idle ✓. */
    connected?: boolean;
    /** Dismiss the ⚠ error indicator on click. A manual dismiss, not a mute —
     *  the next failing sync re-raises it. */
    onclear?: () => void;
  }

  let {
    statusMessage,
    indicatorVisible,
    offline,
    error = false,
    errorMessage = '',
    connected = false,
    onclear,
  }: Props = $props();
</script>

{#if offline}
  <div class="sync-indicator sync-offline">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="2" x2="22" y1="2" y2="22"/>
      <path d="M8.5 16.5a5 5 0 0 1 7 0"/>
      <path d="M2 8.82a15 15 0 0 1 4.17-2.65"/>
      <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/>
      <path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/>
      <path d="M5 12.86a10 10 0 0 1 5.17-2.86"/>
      <line x1="12" x2="12.01" y1="20" y2="20"/>
    </svg>
  </div>
{:else if error}
  <button
    type="button"
    class="sync-indicator sync-error"
    onclick={() => onclear?.()}
    title={`${errorMessage} — click to dismiss`}
    aria-label={`Sync error: ${errorMessage}. Click to dismiss.`}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
      <path d="M12 9v4"/>
      <path d="M12 17h.01"/>
    </svg>
  </button>
{:else if indicatorVisible}
  <div class="sync-indicator">
    <svg class="sync-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
  </div>
{:else if connected}
  <div class="sync-indicator sync-idle" role="status" aria-label="Sync up to date">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 6 9 17l-5-5"/>
    </svg>
  </div>
{/if}

<style>
  /* Base .sync-indicator / .sync-offline positioning + color lives in
     src/styles/components.css. Only the error modifier is scoped here. */
  .sync-indicator.sync-error {
    color: var(--color-muted);
    opacity: 0.7;
    pointer-events: auto;
    cursor: default;
    /* Reset native <button> chrome — the indicator is icon-only. */
    background: none;
    border: none;
    padding: 0;
    line-height: 0;
  }
  .sync-indicator.sync-error:hover {
    opacity: 1;
  }

  /* Idle "up to date" tick — subtle so a persistent healthy indicator
     doesn't compete with the editor. */
  .sync-indicator.sync-idle {
    color: var(--color-muted);
    opacity: 0.45;
    pointer-events: none;
  }
</style>
