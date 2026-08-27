<script lang="ts">
  import type { CrashReport } from './crashHandler';
  import { keyboard } from '$features/editor/keyboard.svelte';
  import { dismissable } from '$shared/dialogs/dismissable';
  import { localizedText } from '$shared/localization';
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
  <!-- Escape dismisses through the shared dialog stack. The old handler sat on
       this panel, which nothing ever focused, so Escape never reached it. -->
  <div
    class="crash-panel"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    use:dismissable={{ ondismiss: handleDiscard }}
  >
    <div class="crash-header">
      <h2 class="crash-title">{localizedText('crashReporting.heading')}</h2>
    </div>

    <div class="crash-content">
      <p class="crash-message">
        {localizedText('crashReporting.desktopPrompt', { count: reportCount })}
      </p>

      {#if firstReport}
        <button
          class="crash-toggle"
          onclick={() => {
            showDetails = !showDetails;
          }}
        >
          <span class="crash-toggle-arrow" class:open={showDetails}>&#9656;</span>
          {localizedText('crashReporting.viewReport')}
        </button>

        {#if showDetails}
          <div class="crash-details">
            <div class="crash-detail-label">{localizedText('crashReporting.details.error')}</div>
            <pre class="crash-detail-value">{firstReport.error}</pre>
            {#if firstReport.stack}
              <div class="crash-detail-label">{localizedText('crashReporting.details.stack')}</div>
              <pre class="crash-detail-value">{firstReport.stack}</pre>
            {/if}
            <div class="crash-detail-label">{localizedText('crashReporting.details.type')}</div>
            <pre class="crash-detail-value">{firstReport.type}</pre>
            <div class="crash-detail-label">{localizedText('crashReporting.details.platform')}</div>
            <pre class="crash-detail-value">{firstReport.platform} | {firstReport.app_version}</pre>
            <button class="crash-copy-btn" onclick={handleCopyReport}>
              {copyFeedback
                ? localizedText('crashReporting.copied')
                : localizedText('crashReporting.copyReport')}
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
        {localizedText('crashReporting.activityPrompt')}
      </button>

      {#if showContext}
        <textarea
          class="crash-textarea"
          placeholder={localizedText('crashReporting.optionalDescriptionPlaceholder')}
          bind:value={userDescription}
          rows="3"></textarea>
      {/if}

      <label class="crash-checkbox-row">
        <input type="checkbox" bind:checked={alwaysSend} />
        <span>{localizedText('crashReporting.sendAutomatically')}</span>
      </label>
    </div>

    <div class="crash-actions">
      <button class="crash-btn crash-btn-secondary" onclick={handleDiscard}
        >{localizedText('crashReporting.dontSend')}</button
      >
      <button class="crash-btn crash-btn-primary" onclick={handleSend}
        >{localizedText('crashReporting.sendReport')}</button
      >
    </div>
  </div>
</div>
