<script lang="ts">
  import type { SyncSummary } from '$lib/sync';

  interface Props {
    syncing: boolean;
    syncStartedAt: number;
    lastSummary: SyncSummary | null;
  }

  let { syncing, syncStartedAt, lastSummary }: Props = $props();

  let visible = $state(false);
  let summaryText = $state('');
  let showSpinner = $state(false);
  let thresholdTimer: number | null = null;
  let hideTimer: number | null = null;

  $effect(() => {
    if (syncing) {
      // Clear any pending hide timer
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }

      // Start 3-second threshold timer — read syncStartedAt to track as $effect dep
      void syncStartedAt;
      thresholdTimer = window.setTimeout(() => {
        thresholdTimer = null;
        // Only show if still syncing
        if (syncing) {
          visible = true;
          showSpinner = true;
          summaryText = '';
        }
      }, 3000);
    } else {
      // Sync ended
      if (thresholdTimer !== null) {
        clearTimeout(thresholdTimer);
        thresholdTimer = null;
      }

      if (visible && lastSummary) {
        // Bar was visible — show summary then fade out
        showSpinner = false;
        const s = lastSummary;
        const parts: string[] = [];
        if (s.uploaded > 0) parts.push(`${s.uploaded} uploaded`);
        if (s.downloaded > 0) parts.push(`${s.downloaded} downloaded`);
        if (s.deleted > 0) parts.push(`${s.deleted} deleted`);
        summaryText = parts.length > 0
          ? `Sync complete — ${parts.join(', ')}`
          : 'Sync complete — everything up to date';

        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          visible = false;
          summaryText = '';
        }, 3000);
      } else {
        // Sync finished before 3s — never show
        visible = false;
      }
    }
  });
</script>

{#if visible}
  <div class="sync-status-bar" class:fading={!showSpinner && summaryText}>
    {#if showSpinner}
      <span class="sync-spinner"></span>
      <span>Syncing...</span>
    {:else}
      <span>{summaryText}</span>
    {/if}
  </div>
{/if}
