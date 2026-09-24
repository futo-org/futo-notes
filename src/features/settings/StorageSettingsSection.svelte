<script lang="ts">
  import { localizedText } from '$shared/localization';

  interface Props {
    notesDirectory: string;
    isCustomDirectory: boolean;
    /** False once the vault folder has gone or the default cannot be created; the actions below are the way out. */
    vaultAvailable: boolean;
    onchange: () => void;
    onreset: () => void;
  }

  let { notesDirectory, isCustomDirectory, vaultAvailable, onchange, onreset }: Props = $props();
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('settings.sections.storage')}</h3>
  <div class="settings-card">
    <p class="settings-btn-desc">{notesDirectory}</p>
    {#if !vaultAvailable}
      <p class="settings-warning">
        {localizedText(
          isCustomDirectory
            ? 'settings.storage.unreachableCurrentWarning'
            : 'settings.storage.uncreatableDefaultWarning',
        )}
      </p>
    {/if}
    <div class="settings-actions" style="margin-top: 10px">
      <button class="settings-btn settings-btn-secondary" onclick={onchange}
        >{localizedText('settings.storage.changeDirectory')}</button
      >
    </div>
    {#if isCustomDirectory}
      <button class="settings-link-btn" onclick={onreset}
        >{localizedText('settings.storage.resetToDefault')}</button
      >
    {/if}
  </div>
</section>
