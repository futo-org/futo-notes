<script lang="ts">
  import { localizedText } from '$shared/localization';

  interface Props {
    resetting: boolean;
    onreset: () => void;
  }

  let { resetting, onreset }: Props = $props();

  function testCrash(): void {
    throw new Error('Test crash from Settings');
  }
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('settings.sections.dangerZone')}</h3>
  <button class="settings-btn settings-btn-danger" onclick={onreset} disabled={resetting}>
    <span class="settings-btn-text">
      <span class="settings-btn-label">{localizedText('settings.danger.fullReset')}</span>
      <span class="settings-btn-desc">
        {resetting
          ? localizedText('settings.danger.deleting')
          : localizedText('settings.danger.permanentlyRemoveAll')}
      </span>
    </span>
  </button>
  {#if import.meta.env.DEV}
    <button class="settings-btn settings-btn-danger" style="margin-top: 8px" onclick={testCrash}>
      <span class="settings-btn-text">
        <span class="settings-btn-label">{localizedText('settings.debug.testCrash.title')}</span>
        <span class="settings-btn-desc">
          {localizedText('settings.debug.testCrash.desktop.description')}
        </span>
      </span>
    </button>
  {/if}
</section>
