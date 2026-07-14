<script lang="ts">
  import { getAppVersion } from '$features/system/crashHandler';
  import { updateChecker } from '$features/system/updateChecker.svelte';

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
  <h3 class="settings-section-title">Updates</h3>
  <div
    class="settings-toggle-row"
    class:disabled={locked}
    onclick={ontoggle}
    role="button"
    tabindex="0"
    onkeydown={(event) => event.key === 'Enter' && ontoggle()}
  >
    <span class="settings-toggle-text">
      <span class="settings-btn-label">Automatically check for updates</span>
      <span class="settings-btn-desc"
        >Periodically check for new versions and notify you when one is available</span
      >
    </span>
    <div class="settings-switch" class:on={enabled}><div class="settings-switch-thumb"></div></div>
  </div>

  {#if enabled}
    <button class="settings-btn" onclick={runUpdateAction} disabled={updateChecker.busy}>
      <span class="settings-btn-text">
        <span class="settings-btn-label">
          {#if updateChecker.phase === 'checking'}
            Checking for updates…
          {:else if updateChecker.phase === 'available'}
            Update &amp; restart
          {:else if updateChecker.phase === 'downloading'}
            Downloading…{updateChecker.percent != null ? ` ${updateChecker.percent}%` : ''}
          {:else if updateChecker.phase === 'installing'}
            Installing…
          {:else if updateChecker.phase === 'restart'}
            Restart now to finish
          {:else if updateChecker.phase === 'error' && updateChecker.pending}
            Retry update — v{updateChecker.pending.currentVersion} → v{updateChecker.pending
              .version}
          {:else}
            Check for updates
          {/if}
        </span>
        <span class="settings-btn-desc">
          {#if updateChecker.phase === 'up-to-date'}
            You're on the latest version (v{getAppVersion()}).
          {:else if updateChecker.phase === 'available'}
            v{updateChecker.pending?.currentVersion} → v{updateChecker.pending?.version}
          {:else if updateChecker.phase === 'downloading' || updateChecker.phase === 'installing'}
            Please wait — the app will restart automatically.
          {:else if updateChecker.phase === 'restart'}
            Update installed. Restart to finish.
          {:else if updateChecker.phase === 'error'}
            {updateChecker.error || 'Update failed.'}
          {:else}
            Currently running v{getAppVersion()}.
          {/if}
        </span>
      </span>
    </button>
    {#if (updateChecker.phase === 'available' || updateChecker.phase === 'error') && updateChecker.pending?.notes}
      <p class="settings-update-notes">{updateChecker.pending.notes}</p>
    {/if}
  {/if}
</section>
