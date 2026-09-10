<script lang="ts">
  import { getAppVersion } from '$features/system/crashHandler';
  import { localizedText } from '$shared/localization';

  import { license } from './license.svelte';
  import { licenseAmbientLabel } from './licenseCopy';

  // The ambient label — the one thing a purchase removes. It is informational
  // and never interrupts: no dialog, no banner, and it never appears in the
  // editor or on any note content (docs/spec/license.md § States and copy, M2).
  interface Props {
    onopenlicense: () => void;
  }

  let { onopenlicense }: Props = $props();

  // `null` is "there is nothing to say here": a license with no purchase year
  // has no "Supporter since {year}" line and gets no yearless stand-in, so the
  // footer is the version alone. An empty button would still be a click target
  // and would still be announced, so the element goes rather than its text.
  const label = $derived(licenseAmbientLabel(license.view));
</script>

<div class="sidebar-footer">
  <span class="sidebar-footer-version"
    >{localizedText('app.desktop.versionShort', { version: getAppVersion() })}</span
  >
  <!-- `title`, deliberately NOT `aria-label`: an aria-label REPLACES the
       accessible name, so labelling the button "Open license settings" is
       exactly how the ambient label — the one word this whole feature exists to
       show or remove — stops being announced at all. The visible text is the
       name; the tooltip only explains what clicking does. -->
  {#if label !== null}
    <button
      class="sidebar-footer-license"
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
    justify-content: space-between;
    gap: 8px;
    flex: 0 0 auto;
    padding: 6px 12px 8px;
    font-size: 11px;
    color: var(--color-muted);
  }

  .sidebar-footer-version {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar-footer-license {
    flex: 0 0 auto;
    padding: 0;
    border: none;
    background: none;
    color: var(--color-muted);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    text-decoration: underline;
    -webkit-tap-highlight-color: transparent;
  }

  .sidebar-footer-license:hover {
    color: var(--color-text);
  }
</style>
