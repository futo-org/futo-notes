<script lang="ts">
  import type { PairingState, UnlockDoor } from '../createHostedSyncSettings.svelte';
  import { puppetRefusal, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
  import { localizedText } from '$shared/localization';

  import ScanDoor from './ScanDoor.svelte';

  interface Props {
    /** Which of the three doors is open. Owned by the caller so the choice
        survives a re-render of this step. */
    door: UnlockDoor;
    busy: boolean;
    /** What the scan door is doing, and what it has to draw. */
    pairing: PairingState;
    pairingPayload: string | null;
    pairingExpiresAt: string | null;
    ondoor: (door: UnlockDoor) => void;
    onvaultpassword: (vaultPassword: string) => Promise<void>;
    onrecoverykey: (typed: string) => Promise<void>;
    onshowpairingcode: () => Promise<void>;
    oncancelpairing: () => Promise<void>;
  }

  let {
    door,
    busy,
    pairing,
    pairingPayload,
    pairingExpiresAt,
    ondoor,
    onvaultpassword,
    onrecoverykey,
    onshowpairingcode,
    oncancelpairing,
  }: Props = $props();

  let vaultPassword = $state('');
  let typedRecoveryKey = $state('');

  // All three doors are one choice a person makes once (parent spec user story
  // 19), so they are all here from the start.
  const DOORS: UnlockDoor[] = ['vaultPassword', 'scan', 'recoveryKey'];

  /** Unlock's click: nothing while the open field is empty, as the button is then disabled. */
  function submit(): Promise<void> | undefined {
    if (busy) return undefined;
    if (door === 'vaultPassword' && vaultPassword) return onvaultpassword(vaultPassword);
    if (door === 'recoveryKey' && typedRecoveryKey) return onrecoverykey(typedRecoveryKey);
    return undefined;
  }

  // What the agent calls each door: `scan` is THIS device showing a code for another to
  // scan, which a name with "scan" in it would read backwards.
  const METHODS: Record<UnlockDoor, string> = {
    vaultPassword: 'vaultPassword',
    recoveryKey: 'recoveryKey',
    scan: 'anotherDevice',
  };
  const doorOf = (method: string) => DOORS.find((option) => METHODS[option] === method)!;

  // The open door's field is the Unlock button's one argument, typed in as a person would.
  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb(
        'SelectUnlockMethod',
        { method: Object.values(METHODS).join('|') as `${string}|${string}` },
        (args) => ondoor(doorOf(args.method as string)),
      ),
      ...(door === 'scan'
        ? []
        : [
            puppetVerb(
              'UnlockVault',
              door === 'vaultPassword' ? { vaultPassword: 'string' } : { recoveryKey: 'string' },
              (args) => {
                if (busy) return puppetRefusal(409, 'hosted sync is busy');
                if (door === 'vaultPassword') vaultPassword = args.vaultPassword as string;
                else typedRecoveryKey = args.recoveryKey as string;
                return submit() ?? puppetRefusal(409, 'the field is empty, so Unlock is disabled');
              },
              {
                controls: [
                  'sync.hosted.unlock.vaultPasswordPlaceholder',
                  'sync.hosted.unlock.recoveryKeyPlaceholder',
                  'sync.hosted.unlock.button',
                  'sync.working',
                ],
              },
            ),
          ]),
    ]),
  );
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
  <ScanDoor
    {pairing}
    payload={pairingPayload}
    expiresAt={pairingExpiresAt}
    {busy}
    onshow={onshowpairingcode}
    oncancel={oncancelpairing}
  />
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
