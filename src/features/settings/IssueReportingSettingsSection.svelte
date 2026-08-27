<script lang="ts">
  import { openExternalUrl } from '$lib/platform/openExternalUrl';
  import { localizedText } from '$shared/localization';

  const ISSUE_TRACKER_URL = 'https://github.com/futo-org/futo-notes/issues';

  interface Props {
    enabled: boolean;
    alwaysSend: boolean;
    ontoggleenabled: () => void;
    ontogglealwayssend: () => void;
  }

  let { enabled, alwaysSend, ontoggleenabled, ontogglealwayssend }: Props = $props();
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
    <div class="settings-switch" class:on={enabled}><div class="settings-switch-thumb"></div></div>
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
  <button
    class="settings-btn settings-issue-link"
    onclick={() => openExternalUrl(ISSUE_TRACKER_URL)}
  >
    <span class="settings-btn-text">
      <span class="settings-btn-label">{localizedText('settings.issueReporting.reportIssue')}</span>
      <span class="settings-btn-desc"
        >{localizedText('settings.issueReporting.openGitHubIssueTracker')}</span
      >
    </span>
    <span class="settings-external-icon" aria-hidden="true">↗</span>
  </button>
</section>
