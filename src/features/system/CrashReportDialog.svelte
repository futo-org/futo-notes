<script lang="ts">
  import type { CrashReport } from './crashHandler';
  import { keyboard } from '$features/editor/keyboard.svelte';
  import './crashReportDialog.css';

  interface Props {
    reports: CrashReport[];
    onresolved: (result: {
      action: 'send' | 'discard';
      alwaysSend: boolean;
      userDescription?: string;
    }) => void;
  }

  let { reports, onresolved }: Props = $props();

  let alwaysSend = $state(false);
  let showDetails = $state(false);
  let showContext = $state(false);
  let userDescription = $state('');
  let copyFeedback = $state(false);

  function handleSend(): void {
    onresolved({
      action: 'send',
      alwaysSend,
      userDescription: userDescription.trim() || undefined,
    });
  }

  function handleDiscard(): void {
    onresolved({ action: 'discard', alwaysSend: false });
  }

  async function handleCopyReport(): Promise<void> {
    if (!firstReport) return;
    const lines = [
      `Error: ${firstReport.error}`,
      firstReport.stack ? `Stack: ${firstReport.stack}` : '',
      `Type: ${firstReport.type}`,
      `Platform: ${firstReport.platform} | ${firstReport.app_version}`,
    ].filter(Boolean);
    await navigator.clipboard.writeText(lines.join('\n'));
    copyFeedback = true;
    setTimeout(() => {
      copyFeedback = false;
    }, 2000);
  }

  const reportCount = $derived(reports.length);
  const firstReport = $derived(reports[0]);
</script>

<div class="crash-overlay" role="presentation" style="padding-bottom: {keyboard.height + 24}px">
  <div
    class="crash-panel"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onkeydown={(e) => e.key === 'Escape' && handleDiscard()}
  >
    <div class="crash-header">
      <h2 class="crash-title">Crash Report</h2>
    </div>

    <div class="crash-content">
      <p class="crash-message">
        The app crashed{reportCount > 1 ? ` (${reportCount} reports)` : ''}. Send a report to help
        us fix it?
      </p>

      {#if firstReport}
        <button
          class="crash-toggle"
          onclick={() => {
            showDetails = !showDetails;
          }}
        >
          <span class="crash-toggle-arrow" class:open={showDetails}>&#9656;</span>
          View report
        </button>

        {#if showDetails}
          <div class="crash-details">
            <div class="crash-detail-label">Error</div>
            <pre class="crash-detail-value">{firstReport.error}</pre>
            {#if firstReport.stack}
              <div class="crash-detail-label">Stack</div>
              <pre class="crash-detail-value">{firstReport.stack}</pre>
            {/if}
            <div class="crash-detail-label">Type</div>
            <pre class="crash-detail-value">{firstReport.type}</pre>
            <div class="crash-detail-label">Platform</div>
            <pre class="crash-detail-value">{firstReport.platform} | {firstReport.app_version}</pre>
            <button class="crash-copy-btn" onclick={handleCopyReport}>
              {copyFeedback ? 'Copied!' : 'Copy report'}
            </button>
          </div>
        {/if}
      {/if}

      <button
        class="crash-toggle"
        onclick={() => {
          showContext = !showContext;
        }}
      >
        <span class="crash-toggle-arrow" class:open={showContext}>&#9656;</span>
        What were you doing?
      </button>

      {#if showContext}
        <textarea
          class="crash-textarea"
          placeholder="Optional: describe what you were doing when the crash happened"
          bind:value={userDescription}
          rows="3"></textarea>
      {/if}

      <label class="crash-checkbox-row">
        <input type="checkbox" bind:checked={alwaysSend} />
        <span>Send crashes automatically</span>
      </label>
    </div>

    <div class="crash-actions">
      <button class="crash-btn crash-btn-secondary" onclick={handleDiscard}>Don't Send</button>
      <button class="crash-btn crash-btn-primary" onclick={handleSend}>Send Report</button>
    </div>
  </div>
</div>
