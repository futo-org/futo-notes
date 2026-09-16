<script lang="ts">
  import { getPlatformFS } from '$lib/platform';
  import { localizedText } from '$shared/localization';
  import { showGlobalToast } from '$shared/notifications/toastBus.svelte';

  import { license } from './license.svelte';
  import { licenseCardModel } from './licenseCopy';
  import SupporterCoin from './SupporterCoin.svelte';

  // The Steel Ledger plate. The three states and their actions are
  // docs/spec/license.md § States and copy. Nothing here is gated on a license:
  // the plate is the only difference a purchase makes.
  //
  // The card *copy* is shared law — `licenseCardModel` is a registered drift
  // concept with iOS and Android copies (scripts/drift-registry.json
  // "license-card-copy") — so this file changes how the state looks, never what
  // it says. Every row is present in every state; a row whose value the
  // activation did not carry renders blank rather than inventing one (D2).
  let entering = $state(false);
  let draft = $state('');
  let field: HTMLInputElement | null = $state(null);
  // Component-local on purpose: leaving Settings unmounts the plate and the key
  // is masked again the next time it is opened. Reveal is a look, not a setting.
  let revealed = $state(false);

  const card = $derived(licenseCardModel(license.view));
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

  // The clipboard is an OS capability, so it is reached through `PlatformFS`
  // and never through a plugin import at this call site (platform discipline).
  async function copyKey(): Promise<void> {
    const key = license.view.key;
    if (key === null) return;
    try {
      await (await getPlatformFS()).writeClipboardText(key);
      showGlobalToast({ path: 'license.card.keyCopied' });
    } catch (error) {
      console.warn('Failed to copy the license key:', error);
    }
  }
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('license.sectionTitle')}</h3>

  <!-- The plate replaces `.settings-card` for this section alone: it is the one
       surface in Settings that is itself the reward. -->
  <div class="license-plate">
    <!-- The well is present in every state; it is empty until there is a coin
         to sit in it, which is what "unlicensed" looks like. -->
    <div class="license-well">
      {#if licensed}
        <div class="license-coin">
          <SupporterCoin celebrate={license.activations} />
        </div>
      {:else}
        <!-- The label sits INSIDE the well rather than on it: `role="img"` makes
             its subtree presentational, so a label on the well would silence the
             coin's own one in the licensed state. -->
        <span
          class="license-well-empty"
          role="img"
          aria-label={localizedText('license.card.emptyWell')}
        ></span>
      {/if}
    </div>

    <div class="license-fields">
      {#if card.badge !== null}
        <span class="license-badge">{card.badge}</span>
      {/if}
      <div class="license-eyebrow">{localizedText('license.card.eyebrow')}</div>
      <div class="license-name">{localizedText('license.card.productName')}</div>

      <dl class="license-rows">
        <div class="license-row license-row-stacked">
          <dt>{localizedText('license.card.keyLabel')}</dt>
          <dd>
            {#if card.maskedKey === null}
              <span class="license-value license-value-blank"></span>
            {:else if revealed}
              <span class="license-value license-key">{license.view.key}</span>
              <button class="license-plate-link" onclick={copyKey}>
                {localizedText('license.card.copyKey')}
              </button>
            {:else}
              <!-- `aria-label` names the button by what clicking does; the dots
                   themselves say nothing out loud. -->
              <button
                class="license-value license-key license-key-masked"
                aria-label={localizedText('license.card.revealKey')}
                onclick={() => (revealed = true)}
              >
                {card.maskedKey}
              </button>
            {/if}
          </dd>
        </div>
        <div class="license-row">
          <dt>{localizedText('license.card.sinceLabel')}</dt>
          <dd><span class="license-value">{card.since ?? ''}</span></dd>
        </div>
        <div class="license-row">
          <dt>{localizedText('license.card.termLabel')}</dt>
          <dd><span class="license-value">{card.term}</span></dd>
        </div>
      </dl>

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
        <!-- The one filled button on the plate. "Enter license key" is the path
             for someone who has already paid, so it reads as a link rather than
             competing with Buy as a second slab of the same weight. -->
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
               device hand-off — so it is a link, not the plate's main slab. -->
          <button class="license-plate-link" onclick={() => void license.remove()}>
            {localizedText('license.remove')}
          </button>
        </div>
      {:else if !entering}
        <div class="license-links">
          <button class="license-plate-link" onclick={startEntry}>
            {localizedText('license.enterKey')}
          </button>
          <button class="license-plate-link" onclick={() => license.openSupport()}>
            {localizedText('license.lostKey')}
          </button>
        </div>
      {/if}
    </div>
  </div>
</section>

<style>
  /* The plate carries its own palette rather than the app's surface tokens: it
     is gunmetal in both themes, so `--color-surface`/`--color-text` would fight
     it. Redefined under `[data-theme='dark']` the way src/styles/theme.css
     does, and — CRITICAL — nothing here may `transition` a theme-dependent
     property, or a theme swap repaints the plate at a different pace than the
     window around it (`just check-theme-single-pace`, docs/spec/app.md). */
  .license-plate {
    --plate-a: #dfe4e8;
    --plate-b: #cdd5dc;
    --plate-ink: #1c2733;
    --plate-ink-dim: #4f5d6a;
    --plate-rule: #a9b4be;
    --plate-accent: #b8860b;

    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 24px;
    padding: 22px 24px;
    border-radius: 12px;
    background: linear-gradient(160deg, var(--plate-a), var(--plate-b));
    color: var(--plate-ink);
  }

  :global([data-theme='dark']) .license-plate {
    --plate-a: #2a3139;
    --plate-b: #1c2228;
    --plate-ink: #e6ebef;
    --plate-ink-dim: #9aa6b1;
    --plate-rule: #3d4650;
    --plate-accent: #ffbb00;
  }

  /* A reserved space, not a drawn recess: @justin 2026-09-16 asked for the
     circle border gone on all three platforms, and the filled disc plus its
     inset edge was that border. The box stays so the layout and the empty
     state keep their shape; nothing is painted in it.

     `align-self: center` and not the plate's `flex-start`: the coin is the
     only thing on this side, and a 184px circle pinned to the top of a taller
     text column reads as having slipped rather than as being placed.

     The size is a constant, not an aspect ratio — in a flex row the main size
     resolves before the cross size, so `aspect-ratio` has no definite height
     to work from and collapses. */
  .license-well {
    flex: 0 0 auto;
    align-self: center;
    display: grid;
    place-items: center;
    width: 184px;
    height: 184px;
  }

  .license-coin {
    width: 160px;
    height: 160px;
  }

  /* `flex: 1 1 260px` is the narrow-pane rule: once the plate's content box
     cannot hold 184 + 24 + 260 the fields wrap onto their own line and the well
     stacks above them. No container query needed, so it also holds inside the
     native shells' webview widths. */
  .license-fields {
    flex: 1 1 260px;
    min-width: 0;
  }

  .license-badge {
    display: inline-block;
    margin-bottom: 10px;
    padding: 2px 9px;
    border: 1px solid var(--plate-accent);
    border-radius: 999px;
    color: var(--plate-accent);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .license-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--plate-ink-dim);
  }

  /* D10: no new font file. The mock's Barlow Condensed becomes the bundled
     Barlow 700, uppercased with tracking. */
  .license-name {
    margin-top: 2px;
    font-size: 24px;
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .license-rows {
    margin: 14px 0 16px;
    border-top: 1px solid var(--plate-rule);
  }

  .license-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 7px 0;
    border-bottom: 1px solid var(--plate-rule);
  }

  /* The key gets the whole column width, label above value. Beside a 184px
     well there is never room for a 39-character key next to its label, and
     letting it fight for the space either overflowed the plate or broke the
     value mid-group at narrow widths. */
  .license-row-stacked {
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
  }

  .license-row dt {
    flex: 0 0 96px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--plate-ink-dim);
  }

  .license-row dd {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 10px;
    margin: 0;
    min-width: 0;
    max-width: 100%;
    font-size: 13px;
  }

  /* Same specificity as the two rules above, so it must come after them.
     `flex-basis` is the MAIN axis: the label column's 96px would otherwise
     become a 96px-TALL label once the row turns into a column. */
  .license-row-stacked dt,
  .license-row-stacked dd {
    flex: 0 0 auto;
  }

  /* A blank row still occupies its line: the value is absent, not the row. */
  .license-value-blank::before {
    content: '';
    display: inline-block;
    height: 1em;
  }

  .license-key {
    max-width: 100%;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    /* No tracking: a 39-character key plus 0.04em lands 4px over the column
       beside the well, and a two-line mask for four pixels is not a look. */
    letter-spacing: normal;
    /* Masked or revealed, the value wraps rather than overflowing the plate. */
    overflow-wrap: anywhere;
  }

  .license-key-masked {
    padding: 0;
    text-align: left;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
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

  /* The app orange, not the plate gold: this is the same action it is
     everywhere else in the app, and it is the ONE filled button on the plate. */
  .license-btn-primary {
    background: var(--color-primary);
    color: #fff;
  }

  .license-btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .license-btn-quiet {
    background: none;
    border-color: var(--plate-rule);
    color: var(--plate-ink);
  }

  .license-btn-quiet:hover:not(:disabled) {
    background: color-mix(in srgb, var(--plate-ink) 8%, transparent);
  }

  .license-btn-wide {
    display: block;
    width: 100%;
  }

  .license-actions {
    display: flex;
    gap: 8px;
  }

  /* The plate's own link colour. `.settings-link-btn` reads the app's muted
     token, which is invisible on gunmetal. */
  .license-plate-link {
    padding: 0;
    border: none;
    background: none;
    color: var(--plate-accent);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    -webkit-tap-highlight-color: transparent;
  }

  .license-plate-link:active {
    opacity: 0.6;
  }

  .license-explanation {
    margin: 12px 0 0;
    font-size: 13px;
    line-height: 1.4;
    color: var(--plate-ink-dim);
  }

  .license-links {
    display: flex;
    gap: 14px;
    margin-top: 8px;
  }

  /* The shared field styles read the app's tokens, which do not belong on the
     plate; only the colours are restated, never the geometry. */
  .license-fields :global(.settings-input-label) {
    color: var(--plate-ink-dim);
  }

  .license-fields :global(.settings-input) {
    border-color: var(--plate-rule);
    background: color-mix(in srgb, var(--plate-ink) 6%, transparent);
    color: var(--plate-ink);
  }
</style>
