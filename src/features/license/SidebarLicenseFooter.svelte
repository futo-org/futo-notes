<script lang="ts">
  import { localizedText } from '$shared/localization';

  import { license } from './license.svelte';
  import { licenseAmbientLabel } from './licenseCopy';

  // The ambient label — the one thing a purchase removes. It is informational
  // and never interrupts: no dialog, no banner, and it never appears in the
  // editor or on any note content (docs/spec/license.md § States and copy, M2).
  //
  // Two things deliberately do NOT live here. The app version used to sit
  // beside the label; Settings → Updates already reads "Currently running
  // v{version}", so this corner is the license's alone. And the supporter coin
  // stays in Settings: this footer sits one keystroke from the editor, and a
  // permanent animation there is exactly the background cost M5 exists to stop.
  interface Props {
    onopenlicense: () => void;
  }

  let { onopenlicense }: Props = $props();

  // `null` is "there is nothing to say here": a license with no purchase year
  // has no "Supporter since {year}" line and gets no yearless stand-in. The
  // element goes rather than its text — an empty button would still be a click
  // target and would still be announced.
  const label = $derived(licenseAmbientLabel(license.view));
  const licensed = $derived(license.view.state === 'licensed');
</script>

<div class="sidebar-footer">
  <!-- `title`, deliberately NOT `aria-label`: an aria-label REPLACES the
       accessible name, so labelling the button "Open license settings" is
       exactly how the ambient label — the one word this whole feature exists to
       show or remove — stops being announced at all. The visible text is the
       name; the tooltip only explains what clicking does. -->
  {#if label !== null}
    <button
      class="sidebar-footer-license"
      class:sidebar-footer-license-supporter={licensed}
      onclick={onopenlicense}
      title={localizedText('license.openLicenseSettings')}
    >
      {label}
    </button>
  {/if}
</div>

<style>
  .sidebar-footer {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    padding: 6px 12px 8px;
    font-size: 11px;
    color: var(--color-muted);
  }

  .sidebar-footer-license {
    min-width: 0;
    overflow: hidden;
    padding: 2px 4px;
    margin-left: -4px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-muted);
    font-family: inherit;
    font-size: inherit;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    /* Underlined only while the label is the affordance to go and pay. Once
       it reads "Supporter since …" it is a statement, not a call to action. */
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
    text-underline-offset: 2px;
  }

  .sidebar-footer-license-supporter {
    text-decoration: none;
    color: var(--color-text);
    font-weight: 500;
  }

  .sidebar-footer-license:hover {
    background: color-mix(in srgb, var(--color-text) 6%, transparent);
    color: var(--color-text);
  }
</style>
