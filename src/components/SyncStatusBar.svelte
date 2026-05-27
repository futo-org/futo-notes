<script lang="ts">
  interface Props {
    statusMessage: string;
    indicatorVisible: boolean;
    offline: boolean;
    error: boolean;
    errorMessage: string;
  }

  let { statusMessage, indicatorVisible, offline, error, errorMessage }: Props = $props();
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
  <div class="sync-indicator sync-error" title={errorMessage}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="5" y1="5" x2="19" y2="19"/>
      <line x1="19" y1="5" x2="5" y2="19"/>
    </svg>
  </div>
{:else if indicatorVisible}
  <div class="sync-indicator">
    <svg class="sync-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
  </div>
{/if}
