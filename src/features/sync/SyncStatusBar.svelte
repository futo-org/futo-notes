<script lang="ts">
  import { Check, LoaderCircle, TriangleAlert, WifiOff } from '@lucide/svelte';
  import { localizedText } from '$shared/localization';

  interface Props {
    statusMessage: string;
    indicatorVisible: boolean;
    offline: boolean;
    error?: boolean;
    errorMessage?: string;
    reconnecting?: boolean;
    connected?: boolean;
    onclear?: () => void;
  }

  let {
    statusMessage,
    indicatorVisible,
    offline,
    error = false,
    errorMessage = '',
    reconnecting = false,
    connected = false,
    onclear,
  }: Props = $props();
</script>

{#if offline}
  <div class="sync-indicator sync-offline">
    <WifiOff size={20} />
  </div>
{:else if error}
  <button
    type="button"
    class="sync-indicator sync-error"
    onclick={() => onclear?.()}
    title={localizedText('sync.errors.dismissTitle', { message: errorMessage })}
    aria-label={localizedText('sync.errors.dismissWithMessageAccessibilityLabel', {
      message: errorMessage,
    })}
  >
    <TriangleAlert size={20} strokeWidth={2.5} />
  </button>
{:else if indicatorVisible}
  <div
    class="sync-indicator"
    role="status"
    aria-label={statusMessage || localizedText('sync.status.syncing')}
  >
    <LoaderCircle class="sync-spinner" size={20} strokeWidth={2.5} />
  </div>
{:else if reconnecting}
  <div
    class="sync-indicator sync-reconnecting"
    role="status"
    aria-label={localizedText('sync.status.reconnectingAccessibilityLabel')}
    title={localizedText('sync.status.reconnectingAccessibilityLabel')}
  >
    <LoaderCircle class="sync-spinner" size={20} strokeWidth={2.5} />
  </div>
{:else if connected}
  <div
    class="sync-indicator sync-idle"
    role="status"
    aria-label={localizedText('sync.status.upToDateAccessibilityLabel')}
  >
    <Check size={20} strokeWidth={2.5} />
  </div>
{/if}

<style>
  /* Base .sync-indicator / .sync-offline positioning + color lives in
     src/styles/sidebar-view-toggle.css (the spinner animation is in
     src/styles/feedback.css). Only the error modifier is scoped here. */
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

  .sync-indicator.sync-reconnecting {
    color: var(--color-muted);
    opacity: 0.5;
    pointer-events: none;
  }

  /* Idle "up to date" tick — subtle so a persistent healthy indicator
     doesn't compete with the editor. */
  .sync-indicator.sync-idle {
    color: var(--color-muted);
    opacity: 0.45;
    pointer-events: none;
  }
</style>
