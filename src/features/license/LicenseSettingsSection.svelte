<script lang="ts">
  import { localizedText } from '$shared/localization';

  import { license } from './license.svelte';
  import { licenseCardModel } from './licenseCopy';
  import SupporterCoin from './SupporterCoin.svelte';

  // The three states and their actions are docs/spec/license.md § States and
  // copy. Nothing here is gated on a license: the row is the only difference a
  // purchase makes.
  //
  // The card *copy* is shared law — `licenseCardModel` is a registered drift
  // concept with iOS and Android copies (scripts/drift-registry.json
  // "license-card-copy") — so this file changes how the state looks, never what
  // it says. The plate itself (the full card) is Phase 4 of
  // docs/plan/license-ship.md; today this renders the model's badge alone.
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
  <div class="settings-card license-card">
    {#if licensed}
      <!-- Its own column, stretched to the card: the coin is the reward, and a
           46px token tucked beside a line of text did not read as one. -->
      <div class="license-coin">
        <SupporterCoin celebrate={license.activations} />
      </div>
    {/if}

    <div class="license-body">
      <div class="license-head">
        {#if !licensed}
          <span class="license-dot" class:license-dot-expired={expired}></span>
        {/if}
        <p class="license-status" class:license-status-licensed={licensed}>
          {licenseCardModel(license.view).badge ?? localizedText('license.statusLicensed')}
        </p>
      </div>

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
            class="license-btn license-btn-primary"
            onclick={submit}
            disabled={license.busy || draft.trim() === ''}
          >
            {license.busy ? localizedText('license.activating') : localizedText('license.activate')}
          </button>
          <button class="license-btn license-btn-quiet" onclick={cancel} disabled={license.busy}>
            {localizedText('license.cancelEntry')}
          </button>
        </div>
      {:else if !licensed}
        <!-- One obvious action. "Enter license key" is the path for someone who
             has already paid, so it reads as a link rather than competing with
             Buy as a second slab of the same weight. -->
        <button
          class="license-btn license-btn-primary license-btn-wide"
          onclick={() => license.openBuyPage()}
        >
          {expired ? localizedText('license.renew') : localizedText('license.buy')}
        </button>
      {/if}

      <p class="license-explanation">
        {localizedText(licensed ? 'license.explanationLicensed' : 'license.explanation')}
      </p>

      {#if licensed}
        <div class="license-links">
          <!-- Reversible by re-entering the key, and there for testing and
               device hand-off — so it is a link, not the card's main slab. -->
          <button class="settings-link-btn" onclick={() => void license.remove()}>
            {localizedText('license.remove')}
          </button>
        </div>
      {:else if !entering}
        <div class="license-links">
          <button class="settings-link-btn" onclick={startEntry}>
            {localizedText('license.enterKey')}
          </button>
          <button class="settings-link-btn" onclick={() => license.openSupport()}>
            {localizedText('license.lostKey')}
          </button>
        </div>
      {/if}
    </div>
  </div>
</section>

<style>
  .license-card {
    display: flex;
    align-items: stretch;
    gap: 16px;
  }

  /* `align-self: stretch` gives the column the card's full content height, and
     the coin frames whichever side is shorter — so it renders at the card's
     height and stays round.

     The width is a constant rather than `aspect-ratio: 1`. In a flex row the
     main size is resolved before the cross size is stretched, so an aspect
     ratio has no definite height to work from and collapses to the minimum
     (measured: a 94px-tall card gave a 64px-wide column). Deriving the width
     from the measured height instead would feed back into how the body's text
     wraps, which changes the height again — a layout that can oscillate. */
  .license-coin {
    flex: 0 0 96px;
    align-self: stretch;
  }

  .license-body {
    flex: 1 1 auto;
    min-width: 0;
  }

  .license-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .license-dot {
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--color-muted);
  }

  .license-dot-expired {
    background: var(--color-primary);
  }

  .license-status {
    margin: 0;
    font-size: 15px;
    line-height: 1.35;
    color: var(--color-muted);
  }

  .license-status-licensed {
    color: var(--color-text);
    font-weight: 500;
  }

  .license-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
  }

  .license-btn {
    padding: 10px 16px;
    border: 1px solid transparent;
    border-radius: 10px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.1s ease;
  }

  .license-btn:active:not(:disabled) {
    transform: scale(0.98);
  }

  .license-btn:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .license-btn-primary {
    background: var(--color-primary);
    color: #fff;
  }

  .license-btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .license-btn-quiet {
    background: none;
    border-color: var(--color-border);
    color: var(--color-text);
  }

  .license-btn-quiet:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-text) 6%, transparent);
  }

  .license-btn-wide {
    display: block;
    width: 100%;
  }

  .license-explanation {
    margin: 10px 0 0;
    font-size: 13px;
    line-height: 1.4;
    color: var(--color-muted);
  }

  .license-links {
    display: flex;
    gap: 14px;
  }
</style>
