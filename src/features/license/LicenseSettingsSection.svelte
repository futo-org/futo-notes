<script lang="ts">
  import { localizedText } from '$shared/localization';

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

  /// Activations this plate has marked, which the coin reads to spin itself up
  /// once. It only ever goes UP, so the spin cannot be torn down by its own
  /// bookkeeping.
  let celebration = $state(0);

  // Collects the one thing worth marking: an activation nothing has marked yet
  // — a key pasted in, or a `futonotes://` link the OS handed us. Opening
  // Settings on a license stored earlier is not that, and neither is opening it
  // on a license that has since been removed, which used to spin the coin over
  // nothing (@justin 2026-09-18).
  $effect(() => {
    if (!license.activationToCelebrate) return;
    license.celebrated();
    celebration += 1;
  });

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
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('license.sectionTitle')}</h3>

  <!-- Its own element rather than `.settings-card`: the geometry is the
       plate's (a coin well beside a field column), the surface is the sheet's. -->
  <div class="license-plate">
    <!-- The well exists only when there is a coin to sit in it. An empty one
         reads as a hole where something failed to load, not as "no license"
         (@justin 2026-09-17) — unlicensed is said by the headline and the ask,
         and the fields take the whole plate instead. -->
    {#if licensed}
      <div class="license-well">
        <div class="license-coin">
          <SupporterCoin celebrate={celebration} />
        </div>
      </div>
    {/if}

    <div class="license-fields">
      <!-- The letterhead belongs to a card, and Unlicensed has no card: it has
           an ask. The badge, the eyebrow and the uppercase product name were
           three pieces of chrome all saying what the section heading and the
           sidebar label already said (@justin 2026-09-18). What is left is the
           shape the sibling FUTO apps use — Grayjay's Buy screen, FUTO
           Keyboard's Payment screen and Immich's purchase panel are each one
           heading, the reason, one button, and a way in for someone who has
           already paid. -->
      {#if card.maskedKey !== null}
        {#if card.badge !== null}
          <span class="license-badge">{card.badge}</span>
        {/if}
        <div class="license-eyebrow">{localizedText('license.card.eyebrow')}</div>
        <div class="license-name">{localizedText('license.card.productName')}</div>

        <!-- Key is the only ledger row left: "Licensed since" and "Term" both
             went out 2026-09-17 (@justin) because nothing records a purchase
             date and nothing limits a license. That leaves no blank row to
             stand for "nothing invented" — a single empty row reads as a void,
             so a stored key is the whole condition for there being a card at
             all. -->
        <dl class="license-rows">
          <div class="license-row license-row-stacked">
            <dt>{localizedText('license.card.keyLabel')}</dt>
            <dd>
              <!-- The same ELEMENT in both states, so revealing cannot change
                   the row's metrics: a `button` and a `span` do not lay out
                   identically, and swapping them moved everything under the
                   key. Only the string changes — and the mask is the key's own
                   length in a monospace face, so each dot is replaced by the
                   character that was under it and nothing moves (@justin
                   2026-09-18). Revealed it stops being a control: selecting and
                   copying is possible but deliberately manual (@justin
                   2026-09-17), a key is not something we want one click away. -->
              {#if revealed}
                <span class="license-value license-key">{license.view.key}</span>
              {:else}
                <!-- `aria-label` names the control by what clicking does; the
                     dots themselves say nothing out loud. -->
                <span
                  class="license-value license-key license-key-masked"
                  role="button"
                  tabindex="0"
                  aria-label={localizedText('license.card.revealKey')}
                  onclick={() => (revealed = true)}
                  onkeydown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      revealed = true;
                    }
                  }}
                >
                  {card.maskedKey}
                </span>
              {/if}
            </dd>
          </div>
        </dl>
      {:else}
        <p class="license-pitch-headline">{localizedText('license.unlicensedHeadline')}</p>
      {/if}

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
        <!-- The reason, then the ask. Grayjay and FUTO Keyboard both put the
             mission paragraph ABOVE the pay button; an argument printed under
             the button it argues for is a footnote. It is the ONLY paragraph:
             a second one saying the app is not locked went out 2026-09-18
             (@justin). Unlicensed and Expired read the same here — only the
             button's word differs. -->
        <p class="license-pitch">{localizedText('license.explanation')}</p>
        <!-- The one filled button on the plate. "I already paid" is the path
             for someone who has, so it reads as a link rather than competing
             with Buy as a second slab of the same weight — the same call
             Grayjay and FUTO Keyboard make with their own already-paid
             affordance. -->
        <button
          class="license-btn license-btn-primary license-btn-wide"
          onclick={() => license.openBuyPage()}
        >
          {expired ? localizedText('license.renew') : localizedText('license.buy')}
        </button>
      {:else}
        <p class="license-explanation">{localizedText('license.explanationLicensed')}</p>
      {/if}

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
  /* The plate sits on the same surface as every other Settings card
     (@justin 2026-09-17): it used to carry its own gunmetal gradient, which
     read as a foreign object in the sheet. Only the gold accent is still the
     plate's own, because the app has no token for it — and it is the one thing
     redefined for dark, the way src/styles/theme.css does. CRITICAL: nothing
     here may `transition` a theme-dependent property, or a theme swap repaints
     the plate at a different pace than the window around it
     (`just check-theme-single-pace`, docs/spec/app.md). */
  .license-plate {
    --plate-ink: var(--color-text);
    --plate-ink-dim: var(--color-muted);
    --plate-rule: var(--color-border);
    --plate-accent: #b8860b;

    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 24px;
    padding: 22px 24px;
    border-radius: 12px;
    background: var(--color-surface);
    color: var(--plate-ink);
  }

  :global([data-theme='dark']) .license-plate {
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

  /* The ask, in the plate's own voice: bigger than the mission paragraph under
     it, so the eye lands here and not on the boilerplate. Not a heading
     element — the section already has one, and this is a sentence. */
  .license-pitch-headline {
    margin: 0 0 8px;
    font-size: 19px;
    font-weight: 600;
    line-height: 1.25;
  }

  .license-pitch {
    margin: 0 0 14px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--plate-ink);
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
