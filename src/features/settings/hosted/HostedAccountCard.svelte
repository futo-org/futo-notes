<script lang="ts">
  import { ANSWER_PARAM, throughConfirmation } from '$app/puppet/puppetConfirm';
  import { puppetRefusal, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
  import { subscriptionStateMessage } from '$features/sync/subscriptionState';
  import type { BillingStatusOutput } from '$features/sync/syncContract.generated';
  import { localizedFileSize, localizedText, resolveLocalizedMessage } from '$shared/localization';

  interface Props {
    email: string;
    billing: BillingStatusOutput | null;
    busy: boolean;
    onmanage: () => Promise<void>;
    onchangevaultpassword: () => void;
    onnewrecoverykey: () => Promise<void>;
    /** Asks first; settles once signed out or declined. */
    onsignout: () => Promise<void>;
  }

  let {
    email,
    billing,
    busy,
    onmanage,
    onchangevaultpassword,
    onnewrecoverykey,
    onsignout,
  }: Props = $props();

  /** What a disabled button says to a verb. */
  function unlessBusy(act: () => void | Promise<void>) {
    return () => (busy ? puppetRefusal(409, 'hosted sync is busy') : act());
  }

  // The "Vault full" banner's button is this same act, and shows only beside this card.
  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb('ManageSubscription', {}, unlessBusy(onmanage), {
        controls: ['sync.hosted.account.manageSubscription', 'sync.hosted.banner.vaultFull.action'],
      }),
      puppetVerb('OpenVaultPasswordChange', {}, unlessBusy(onchangevaultpassword), {
        controls: ['sync.hosted.account.changeVaultPassword'],
      }),
      puppetVerb('ReplaceRecoveryKey', {}, unlessBusy(onnewrecoverykey), {
        controls: ['sync.hosted.account.newRecoveryKey'],
      }),
      puppetVerb('SignOutOfFuto', ANSWER_PARAM, () => throughConfirmation(onsignout), {
        controls: ['sync.hosted.account.signOut'],
      }),
    ]),
  );

  const state = $derived(billing ? resolveLocalizedMessage(subscriptionStateMessage(billing)) : '');
  const storage = $derived(
    billing
      ? localizedText('sync.hosted.account.storage', {
          used: localizedFileSize(billing.bytesUsed),
          quota: localizedFileSize(billing.storageQuotaBytes),
        })
      : '',
  );
</script>

<p class="hosted-title">{localizedText('sync.hosted.account.heading')}</p>

<p class="hosted-account-email">{email}</p>
<p class="hosted-account-state">{state}</p>
<p class="settings-btn-desc settings-hint">{storage}</p>

<div class="settings-actions">
  <button class="settings-btn settings-btn-inline" onclick={() => void onmanage()} disabled={busy}>
    {localizedText('sync.hosted.account.manageSubscription')}
  </button>
</div>

<!-- Neither asks for a current secret: this device already holds the vault
     key, and a device set up by scanning a code never knew the vault password
     (ADR 0003, decision 10). -->
<div class="settings-actions">
  <button class="settings-btn settings-btn-inline" onclick={onchangevaultpassword} disabled={busy}>
    {localizedText('sync.hosted.account.changeVaultPassword')}
  </button>
  <button
    class="settings-btn settings-btn-inline"
    onclick={() => void onnewrecoverykey()}
    disabled={busy}
  >
    {localizedText('sync.hosted.account.newRecoveryKey')}
  </button>
</div>

<button class="settings-link-btn" onclick={() => void onsignout()}>
  {localizedText('sync.hosted.account.signOut')}
</button>
