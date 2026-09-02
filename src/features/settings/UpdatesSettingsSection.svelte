<script lang="ts">
  import { getAppVersion } from '$features/system/crashHandler';
  import { updateChecker } from '$features/system/updateChecker.svelte';
  import { localizedText } from '$shared/localization';

  interface Props {
    enabled: boolean;
    locked: boolean;
    ontoggle: () => void;
  }

  let { enabled, locked, ontoggle }: Props = $props();

  function runUpdateAction(): void {
    if (updateChecker.phase === 'restart') void updateChecker.restart();
    else if (
      updateChecker.phase === 'available' ||
      (updateChecker.phase === 'error' && updateChecker.pending)
    ) {
      void updateChecker.install();
    } else void updateChecker.check();
  }
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('settings.updates.heading')}</h3>
  <div
    class="settings-toggle-row"
    class:disabled={locked}
    onclick={ontoggle}
    role="button"
    tabindex="0"
    onkeydown={(event) => event.key === 'Enter' && ontoggle()}
  >
    <span class="settings-toggle-text">
      <span class="settings-btn-label">{localizedText('settings.updates.automaticChecks')}</span>
      <span class="settings-btn-desc">{localizedText('settings.updates.description')}</span>
    </span>
    <div class="settings-switch" class:on={enabled}><div class="settings-switch-thumb"></div></div>
  </div>

  {#if enabled}
    <button class="settings-btn" onclick={runUpdateAction} disabled={updateChecker.busy}>
      <span class="settings-btn-text">
        <span class="settings-btn-label">
          {#if updateChecker.phase === 'checking'}
            {localizedText('settings.updates.checking')}
          {:else if updateChecker.phase === 'available'}
            {localizedText('settings.updates.updateAndRestart')}
          {:else if updateChecker.phase === 'downloading'}
            {updateChecker.percent != null
              ? localizedText('settings.updates.downloadingProgress', {
                  percent: updateChecker.percent,
                })
              : localizedText('settings.updates.downloading')}
          {:else if updateChecker.phase === 'installing'}
            {localizedText('settings.updates.installing')}
          {:else if updateChecker.phase === 'restart'}
            {localizedText('settings.updates.restartNow')}
          {:else if updateChecker.phase === 'error' && updateChecker.pending}
            {localizedText('settings.updates.retryVersion', {
              currentVersion: updateChecker.pending.currentVersion,
              newVersion: updateChecker.pending.version,
            })}
          {:else}
            {localizedText('settings.updates.checkForUpdates')}
          {/if}
        </span>
        <span class="settings-btn-desc">
          {#if updateChecker.phase === 'up-to-date'}
            {localizedText('settings.updates.latestVersion', { version: getAppVersion() })}
          {:else if updateChecker.phase === 'available'}
            {localizedText('settings.updates.versionTransition', {
              currentVersion: updateChecker.pending?.currentVersion ?? '',
              newVersion: updateChecker.pending?.version ?? '',
            })}
          {:else if updateChecker.phase === 'downloading' || updateChecker.phase === 'installing'}
            {localizedText('settings.updates.pleaseWait')}
          {:else if updateChecker.phase === 'restart'}
            {localizedText('settings.updates.installedRestart')}
          {:else if updateChecker.phase === 'error'}
            {localizedText('settings.updates.failed')}
          {:else}
            {localizedText('settings.updates.currentVersion', { version: getAppVersion() })}
          {/if}
        </span>
      </span>
    </button>
    {#if (updateChecker.phase === 'available' || updateChecker.phase === 'error') && updateChecker.pending?.notes}
      <p class="settings-update-notes">{updateChecker.pending.notes}</p>
    {/if}
  {/if}
</section>
