<script lang="ts">
  import { slide } from 'svelte/transition';

  import FeedbackForm from '$features/feedback/FeedbackForm.svelte';
  import { localizedText } from '$shared/localization';
  import { showGlobalToast } from '$shared/notifications/toastBus.svelte';

  interface Props {
    enabled: boolean;
    alwaysSend: boolean;
    ontoggleenabled: () => void;
    ontogglealwayssend: () => void;
  }

  let { enabled, alwaysSend, ontoggleenabled, ontogglealwayssend }: Props = $props();

  let composing = $state(false);
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('settings.sections.issueReporting')}</h3>
  <div
    class="settings-toggle-row settings-issue-first-row"
    onclick={ontoggleenabled}
    role="button"
    tabindex="0"
    onkeydown={(event) => event.key === 'Enter' && ontoggleenabled()}
  >
    <span class="settings-toggle-text">
      <span class="settings-btn-label"
        >{localizedText('settings.issueReporting.shareCrashReports')}</span
      >
      <span class="settings-btn-desc">{localizedText('settings.issueReporting.shareHelp')}</span>
    </span>
    <div class="settings-switch" class:on={enabled}>
      <div class="settings-switch-thumb"></div>
    </div>
  </div>
  {#if enabled}
    <div
      class="settings-toggle-row settings-issue-middle-row"
      onclick={ontogglealwayssend}
      role="button"
      tabindex="0"
      onkeydown={(event) => event.key === 'Enter' && ontogglealwayssend()}
    >
      <span class="settings-toggle-text">
        <span class="settings-btn-label"
          >{localizedText('settings.issueReporting.sendAutomatically')}</span
        >
        <span class="settings-btn-desc"
          >{localizedText('settings.issueReporting.sendWithoutAsking')}</span
        >
      </span>
      <div class="settings-switch" class:on={alwaysSend}>
        <div class="settings-switch-thumb"></div>
      </div>
    </div>
  {/if}
  <div class="settings-issue-feedback">
    <button
      class="settings-btn settings-issue-link"
      class:open={composing}
      aria-expanded={composing}
      onclick={() => (composing = !composing)}
    >
      <span class="settings-btn-text">
        <span class="settings-btn-label"
          >{localizedText('settings.issueReporting.sendFeedback')}</span
        >
        <span class="settings-btn-desc"
          >{localizedText('settings.issueReporting.sendFeedbackDescription')}</span
        >
      </span>
      <svg
        class="settings-issue-chevron"
        aria-hidden="true"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
    {#if composing}
      <div class="settings-issue-form" transition:slide={{ duration: 220 }}>
        <FeedbackForm
          onsent={() => {
            composing = false;
            showGlobalToast({ path: 'feedback.sentThanks' });
          }}
        />
      </div>
    {/if}
  </div>
</section>
