<script lang="ts">
  import { localizedText } from '$shared/localization';

  interface Props {
    notesDirectory: string;
    isCustomDirectory: boolean;
    /** False once the vault folder has gone, cannot be created or refused a write; the actions below are the way out. */
    vaultAvailable: boolean;
    /** The folder is there but refused a write (Controlled Folder Access, a read-only mount). */
    accessRefused: boolean;
    onchange: () => void;
    onreset: () => void;
  }

  let {
    notesDirectory,
    isCustomDirectory,
    vaultAvailable,
    accessRefused,
    onchange,
    onreset,
  }: Props = $props();

  const warningPath = $derived(
    accessRefused
      ? 'settings.storage.accessRefusedWarning'
      : isCustomDirectory
        ? 'settings.storage.unreachableCurrentWarning'
        : 'settings.storage.uncreatableDefaultWarning',
  );
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('settings.sections.storage')}</h3>
  <div class="settings-card">
    <p class="settings-btn-desc">{notesDirectory}</p>
    {#if !vaultAvailable}
      <p class="settings-warning">
        {localizedText(warningPath)}
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
