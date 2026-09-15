<script lang="ts">
  import { localizedText } from '$shared/localization';

  import type { HostedSyncSettings } from './createHostedSyncSettings.svelte';
  import type { SyncSettings } from './createSyncSettings.svelte';
  import SyncSettingsSection from './SyncSettingsSection.svelte';
  import CreateVaultStep from './hosted/CreateVaultStep.svelte';
  import HostedAccountCard from './hosted/HostedAccountCard.svelte';
  import RecoveryKeyStep from './hosted/RecoveryKeyStep.svelte';
  import UnlockStep from './hosted/UnlockStep.svelte';

  interface Props {
    hosted: HostedSyncSettings;
    /** Today's self-hosted settings, rendered unchanged behind the disclosure. */
    sync: SyncSettings;
    backgroundError: boolean;
    backgroundErrorMessage: string;
    reconnecting: boolean;
  }

  let { hosted, sync, backgroundError, backgroundErrorMessage, reconnecting }: Props = $props();
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('settings.sections.sync')}</h3>
  <div class="settings-card">
    {#if hosted.error}
      <p class="hosted-error" role="alert">{hosted.error}</p>
    {/if}

    {#if hosted.banner === 'syncPaused'}
      <div class="hosted-banner">
        <p class="hosted-banner-title">{localizedText('sync.hosted.banner.syncPaused.title')}</p>
        <p class="hosted-banner-body">{localizedText('sync.hosted.banner.syncPaused.body')}</p>
        <div class="settings-actions">
          <button
            class="settings-btn settings-btn-inline"
            onclick={() => void hosted.subscribe()}
            disabled={hosted.busy}
          >
            {localizedText('sync.hosted.banner.syncPaused.action')}
          </button>
        </div>
      </div>
    {:else if hosted.banner === 'vaultFull'}
      <div class="hosted-banner">
        <p class="hosted-banner-title">{localizedText('sync.hosted.banner.vaultFull.title')}</p>
        <p class="hosted-banner-body">{localizedText('sync.hosted.banner.vaultFull.body')}</p>
        <div class="settings-actions">
          <button
            class="settings-btn settings-btn-inline"
            onclick={() => void hosted.manageSubscription()}
            disabled={hosted.busy}
          >
            {localizedText('sync.hosted.banner.vaultFull.action')}
          </button>
        </div>
      </div>
    {/if}

    <!-- Which screen this is comes from Rust's `current_step`, never from a
         position kept here, which is what makes quitting mid-wizard and
         reopening land on the right step. -->
    {#if hosted.screen === 'loading'}
      <p class="settings-btn-desc settings-hint">{localizedText('sync.hosted.loading')}</p>
    {:else if hosted.screen === 'unavailable'}
      <p class="settings-btn-desc settings-hint">{localizedText('sync.hosted.unavailable')}</p>
    {:else if hosted.screen === 'signIn'}
      <p class="hosted-title">{localizedText('sync.hosted.signIn.title')}</p>
      <p class="hosted-body">{localizedText('sync.hosted.signIn.body')}</p>
      <div class="settings-actions">
        <button
          class="settings-btn settings-btn-inline"
          onclick={() => void hosted.signIn()}
          disabled={hosted.busy}
        >
          {localizedText('sync.hosted.signIn.button')}
        </button>
      </div>
      <p class="settings-btn-desc settings-hint">
        {localizedText('sync.hosted.signIn.serverLine', { server: hosted.serverUrl })}
      </p>
    {:else if hosted.screen === 'subscribe'}
      <p class="hosted-title">{localizedText('sync.hosted.subscribe.title')}</p>
      <p class="hosted-body">{localizedText('sync.hosted.subscribe.body')}</p>
      <div class="settings-actions">
        <button
          class="settings-btn settings-btn-inline"
          onclick={() => void hosted.subscribe()}
          disabled={hosted.busy}
        >
          {localizedText('sync.hosted.subscribe.button')}
        </button>
      </div>
    {:else if hosted.screen === 'createVault'}
      <CreateVaultStep
        minimumLength={hosted.minVaultPasswordLength}
        busy={hosted.busy}
        oncreate={(vaultPassword) => void hosted.createVault(vaultPassword)}
      />
    {:else if hosted.screen === 'recoveryKey' && hosted.recoveryKey}
      <RecoveryKeyStep
        recoveryKey={hosted.recoveryKey}
        saved={hosted.recoveryKeySaved}
        busy={hosted.busy}
        onsavedchange={(saved) => (hosted.recoveryKeySaved = saved)}
        oncopy={() => void hosted.copyRecoveryKey()}
        onsavefile={() => void hosted.saveRecoveryKeyToFile()}
        oncontinue={() => void hosted.continueAfterRecoveryKey()}
      />
    {:else if hosted.screen === 'unlock'}
      <UnlockStep
        door={hosted.unlockDoor}
        busy={hosted.busy}
        ondoor={(door) => (hosted.unlockDoor = door)}
        onvaultpassword={(vaultPassword) => void hosted.unlockWithPassword(vaultPassword)}
        onrecoverykey={(typed) => void hosted.unlockWithRecoveryKey(typed)}
      />
    {:else if hosted.screen === 'account'}
      <HostedAccountCard
        email={hosted.email}
        billing={hosted.billing}
        busy={hosted.busy}
        onmanage={() => void hosted.manageSubscription()}
        onsignout={() => void hosted.signOut()}
      />
    {/if}

    <!-- A browser window is open and Rust is polling for its outcome. -->
    {#if hosted.waiting}
      <p class="settings-btn-desc settings-hint" role="status">
        {hosted.waiting === 'signIn'
          ? localizedText('sync.hosted.signIn.waiting')
          : localizedText('sync.hosted.subscribe.waiting')}
      </p>
      <button class="settings-link-btn" onclick={() => void hosted.cancelWaiting()}>
        {localizedText('sync.hosted.cancel')}
      </button>
    {/if}
  </div>
</section>

<!-- Self-hosting is unchanged and stays available: this is literally the
     screen the flag-off build renders, disclosed rather than reimplemented
     (parent spec user story 34). -->
{#if hosted.screen !== 'account'}
  <button
    class="settings-link-btn"
    aria-expanded={hosted.selfHostedOpen}
    onclick={() => (hosted.selfHostedOpen = !hosted.selfHostedOpen)}
  >
    {localizedText('sync.hosted.useMyOwnServer')}
  </button>
  {#if hosted.selfHostedOpen}
    <SyncSettingsSection {sync} {backgroundError} {backgroundErrorMessage} {reconnecting} />
  {/if}
{/if}
