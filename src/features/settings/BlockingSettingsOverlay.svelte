<script lang="ts">
  interface Props {
    error?: string;
    phase: string;
    oncancel?: () => void;
  }

  let { error = '', phase, oncancel }: Props = $props();
</script>

<div class="connect-sync-overlay">
  {#if error}
    <div class="connect-sync-error">{error}</div>
    {#if oncancel}
      <button class="connect-sync-cancel" onclick={oncancel}>Close</button>
    {/if}
  {:else}
    <div class="connect-sync-spinner"></div>
    <div class="connect-sync-phase">{phase}</div>
  {/if}
</div>
