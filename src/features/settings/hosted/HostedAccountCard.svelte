<script lang="ts">
  import { subscriptionStateMessage } from '$features/sync/subscriptionState';
  import type { BillingStatusOutput } from '$features/sync/syncContract.generated';
  import { localizedFileSize, localizedText, resolveLocalizedMessage } from '$shared/localization';

  interface Props {
    email: string;
    billing: BillingStatusOutput | null;
    busy: boolean;
    onmanage: () => void;
    onsignout: () => void;
  }

  let { email, billing, busy, onmanage, onsignout }: Props = $props();

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
  <button class="settings-btn settings-btn-inline" onclick={onmanage} disabled={busy}>
    {localizedText('sync.hosted.account.manageSubscription')}
  </button>
</div>

<button class="settings-link-btn" onclick={onsignout}>
  {localizedText('sync.hosted.account.signOut')}
</button>
