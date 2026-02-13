<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { Keyboard } from '@capacitor/keyboard';
  import type { CrashReport } from '$lib/crashHandler';

  interface Props {
    reports: CrashReport[];
    onresolved: (result: { action: 'send' | 'discard'; alwaysSend: boolean; userDescription?: string }) => void;
  }

  let { reports, onresolved }: Props = $props();

  let alwaysSend = $state(true);
  let showDetails = $state(false);
  let showContext = $state(false);
  let userDescription = $state('');
  let keyboardHeight = $state(0);

  $effect(() => {
    if (Capacitor.isNativePlatform()) {
      const showHandle = Keyboard.addListener('keyboardWillShow', (info) => {
        keyboardHeight = info.keyboardHeight;
      });
      const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
        keyboardHeight = 0;
      });
      return () => {
        showHandle.then(h => h.remove());
        hideHandle.then(h => h.remove());
      };
    } else {
      const vv = window.visualViewport;
      if (!vv) return;
      const onResize = () => {
        const diff = window.innerHeight - vv.height;
        keyboardHeight = diff > 100 ? diff : 0;
      };
      vv.addEventListener('resize', onResize);
      return () => vv.removeEventListener('resize', onResize);
    }
  });

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

  const reportCount = $derived(reports.length);
  const firstReport = $derived(reports[0]);
</script>

<div class="crash-overlay" role="button" tabindex="-1" onclick={handleDiscard} onkeydown={(e) => e.key === 'Escape' && handleDiscard()} style="padding-bottom: {keyboardHeight + 24}px">
  <div class="crash-panel" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <div class="crash-header">
      <h2 class="crash-title">Crash Report</h2>
    </div>

    <div class="crash-content">
      <p class="crash-message">
        The app crashed{reportCount > 1 ? ` (${reportCount} reports)` : ''}. Send a report to help us fix it?
      </p>

      {#if firstReport}
        <button class="crash-toggle" onclick={() => { showDetails = !showDetails; }}>
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
          </div>
        {/if}
      {/if}

      <button class="crash-toggle" onclick={() => { showContext = !showContext; }}>
        <span class="crash-toggle-arrow" class:open={showContext}>&#9656;</span>
        What were you doing?
      </button>

      {#if showContext}
        <textarea
          class="crash-textarea"
          placeholder="Optional: describe what you were doing when the crash happened"
          bind:value={userDescription}
          rows="3"
        ></textarea>
      {/if}

      <label class="crash-checkbox-row">
        <input type="checkbox" bind:checked={alwaysSend} />
        <span>Always send crash reports</span>
      </label>
    </div>

    <div class="crash-actions">
      <button class="crash-btn crash-btn-secondary" onclick={handleDiscard}>Don't Send</button>
      <button class="crash-btn crash-btn-primary" onclick={handleSend}>Send Report</button>
    </div>
  </div>
</div>

<style>
  .crash-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .crash-panel {
    width: 100%;
    max-width: 400px;
    max-height: 80vh;
    background: var(--color-bg);
    border-radius: 16px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .crash-header {
    padding: 20px 20px 0;
  }

  .crash-title {
    font-size: 18px;
    font-weight: 700;
    margin: 0;
    color: var(--color-text);
  }

  .crash-content {
    padding: 12px 20px;
  }

  .crash-message {
    font-size: 15px;
    color: var(--color-text);
    margin: 0 0 16px;
    line-height: 1.4;
  }

  .crash-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: none;
    padding: 8px 0;
    font-size: 14px;
    color: var(--color-muted);
    cursor: pointer;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
  }

  .crash-toggle:active {
    opacity: 0.7;
  }

  .crash-toggle-arrow {
    display: inline-block;
    font-size: 12px;
    transition: transform 0.15s ease;
  }

  .crash-toggle-arrow.open {
    transform: rotate(90deg);
  }

  .crash-details {
    background: var(--color-surface);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 8px;
    overflow-x: auto;
  }

  .crash-detail-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-muted);
    margin-bottom: 2px;
  }

  .crash-detail-label:not(:first-child) {
    margin-top: 8px;
  }

  .crash-detail-value {
    font-size: 12px;
    font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace;
    color: var(--color-text);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.4;
  }

  .crash-textarea {
    width: 100%;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 10px;
    font-size: 14px;
    font-family: inherit;
    color: var(--color-text);
    background: var(--color-surface);
    resize: vertical;
    margin-bottom: 8px;
    box-sizing: border-box;
  }

  .crash-textarea:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .crash-checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: var(--color-text);
    padding: 8px 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .crash-checkbox-row input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: var(--color-primary);
  }

  .crash-actions {
    display: flex;
    gap: 12px;
    padding: 4px 20px 20px;
  }

  .crash-btn {
    flex: 1;
    padding: 12px 16px;
    border: none;
    border-radius: 10px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
  }

  .crash-btn:active {
    opacity: 0.8;
  }

  .crash-btn-secondary {
    background: var(--color-surface);
    color: var(--color-text);
  }

  .crash-btn-primary {
    background: var(--color-primary);
    color: white;
  }
</style>
