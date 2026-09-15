<script lang="ts">
  import type { UnlockDoor } from '../createHostedSyncSettings.svelte';
  import { localizedText } from '$shared/localization';

  interface Props {
    /** Which of the three doors is open. Owned by the caller so the choice
        survives a re-render of this step. */
    door: UnlockDoor;
    busy: boolean;
    ondoor: (door: UnlockDoor) => void;
    onvaultpassword: (vaultPassword: string) => void;
    onrecoverykey: (typed: string) => void;
  }

  let { door, busy, ondoor, onvaultpassword, onrecoverykey }: Props = $props();

  let vaultPassword = $state('');
  let typedRecoveryKey = $state('');

  // The scan door is here from the start, named and visible, because the three
  // doors are one choice a person makes once (parent spec user story 19). It
  // does nothing until the pairing ticket lands, and says so rather than
  // pretending.
  const DOORS: UnlockDoor[] = ['vaultPassword', 'scan', 'recoveryKey'];

  function submit(): void {
    if (busy) return;
    if (door === 'vaultPassword' && vaultPassword) onvaultpassword(vaultPassword);
    if (door === 'recoveryKey' && typedRecoveryKey) onrecoverykey(typedRecoveryKey);
  }
</script>

<p class="hosted-title">{localizedText('sync.hosted.unlock.title')}</p>
<p class="hosted-body">{localizedText('sync.hosted.unlock.body')}</p>

<div
  class="hosted-doors"
  role="radiogroup"
  aria-label={localizedText('sync.hosted.unlock.doorsAccessibilityLabel')}
>
  {#each DOORS as option (option)}
    <button
      class="hosted-door"
      class:active={door === option}
      role="radio"
      aria-checked={door === option}
      onclick={() => ondoor(option)}
    >
      {localizedText(`sync.hosted.unlock.doors.${option}`)}
    </button>
  {/each}
</div>

{#if door === 'vaultPassword'}
  <label class="settings-input-label" for="hosted-unlock-password">
    {localizedText('sync.hosted.unlock.vaultPasswordLabel')}
  </label>
  <input
    id="hosted-unlock-password"
    class="settings-input"
    type="password"
    bind:value={vaultPassword}
    placeholder={localizedText('sync.hosted.unlock.vaultPasswordPlaceholder')}
    autocapitalize="off"
    autocomplete="current-password"
    spellcheck="false"
    onkeydown={(event) => event.key === 'Enter' && submit()}
  />
  <div class="settings-actions">
    <button
      class="settings-btn settings-btn-inline"
      onclick={submit}
      disabled={busy || !vaultPassword}
    >
      {busy ? localizedText('sync.working') : localizedText('sync.hosted.unlock.button')}
    </button>
  </div>
{:else if door === 'scan'}
  <p class="settings-warning">{localizedText('sync.hosted.unlock.scanNotReady')}</p>
{:else}
  <label class="settings-input-label" for="hosted-unlock-recovery-key">
    {localizedText('sync.hosted.unlock.recoveryKeyLabel')}
  </label>
  <input
    id="hosted-unlock-recovery-key"
    class="settings-input"
    type="text"
    bind:value={typedRecoveryKey}
    placeholder={localizedText('sync.hosted.unlock.recoveryKeyPlaceholder')}
    autocapitalize="off"
    autocomplete="off"
    spellcheck="false"
    onkeydown={(event) => event.key === 'Enter' && submit()}
  />
  <p class="settings-btn-desc settings-hint">
    {localizedText('sync.hosted.unlock.recoveryKeyHint')}
  </p>
  <div class="settings-actions">
    <button
      class="settings-btn settings-btn-inline"
      onclick={submit}
      disabled={busy || !typedRecoveryKey}
    >
      {busy ? localizedText('sync.working') : localizedText('sync.hosted.unlock.button')}
    </button>
  </div>
{/if}
