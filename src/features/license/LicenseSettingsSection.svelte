<script lang="ts">
  import { localizedText } from '$shared/localization';

  import { license } from './license.svelte';
  import { licenseRowText } from './licenseCopy';

  // The three states and their actions are docs/spec/license.md § States and
  // copy. Nothing here is gated on a license: the row is the only difference a
  // purchase makes.
  let entering = $state(false);
  let draft = $state('');
  let field: HTMLInputElement | null = $state(null);

  const licensed = $derived(license.view.state === 'licensed');
  const expired = $derived(license.view.state === 'expired');

  function startEntry(): void {
    entering = true;
    draft = '';
    // The field is created by this same update, so focus after it exists.
    queueMicrotask(() => field?.focus());
  }

  async function submit(): Promise<void> {
    if (draft.trim() === '') return;
    // One call: recognise, activate if it was a bare key, verify, store.
    const accepted = await license.enterKey(draft);
    if (accepted) {
      entering = false;
      draft = '';
    }
  }

  function cancel(): void {
    entering = false;
    draft = '';
  }
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('license.sectionTitle')}</h3>
  <div class="settings-card">
    <p class="license-status">{licenseRowText(license.view)}</p>

    {#if entering}
      <label class="settings-input-label" for="license-key-input">
        {localizedText('license.keyLabel')}
      </label>
      <input
        id="license-key-input"
        class="settings-input"
        bind:this={field}
        bind:value={draft}
        placeholder={localizedText('license.keyPlaceholder')}
        autocomplete="off"
        spellcheck="false"
        onkeydown={(event) => {
          if (event.key === 'Enter') void submit();
          if (event.key === 'Escape') cancel();
        }}
      />
      <div class="license-actions">
        <button
          class="settings-btn settings-btn-inline"
          onclick={submit}
          disabled={license.busy || draft.trim() === ''}
        >
          {license.busy ? localizedText('license.activating') : localizedText('license.activate')}
        </button>
        <button class="settings-btn settings-btn-inline" onclick={cancel} disabled={license.busy}>
          {localizedText('license.cancelEntry')}
        </button>
      </div>
    {:else}
      <div class="license-actions">
        {#if licensed}
          <button class="settings-btn settings-btn-inline" onclick={() => void license.remove()}>
            {localizedText('license.remove')}
          </button>
        {:else}
          <button class="settings-btn settings-btn-inline" onclick={() => license.openBuyPage()}>
            {expired ? localizedText('license.renew') : localizedText('license.buy')}
          </button>
          <button class="settings-btn settings-btn-inline" onclick={startEntry}>
            {localizedText('license.enterKey')}
          </button>
        {/if}
      </div>
    {/if}

    <p class="settings-btn-desc">{localizedText('license.explanation')}</p>

    {#if !licensed}
      <button class="settings-link-btn" onclick={() => license.openSupport()}>
        {localizedText('license.lostKey')}
      </button>
    {/if}
  </div>
</section>

<style>
  .license-status {
    margin: 0 0 10px;
    font-size: 14px;
    color: var(--color-text);
  }

  .license-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
  }
</style>
