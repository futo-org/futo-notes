<script lang="ts">
  import type { VaultStatus } from '$lib/platform/tauri';
  import { localizedText } from '$shared/localization';

  import { chooseNotesDirectory } from './notesDirectory';
  import { vaultAvailability } from './vaultAvailability.svelte';

  // Stays up for the rest of the launch, unlike a toast: while it is up every
  // edit is locked, and the lock only makes sense next to it.
  // The folder is named on purpose — github#44's reporter read an unnamed
  // failure as a server fault and audited a healthy server first.
  const status = $derived(vaultAvailability.unavailable ? vaultAvailability.status : null);

  function reasonPath(unusable: VaultStatus): string {
    if (unusable.accessRefused) return 'storage.unavailableBanner.accessRefused';
    return unusable.isCustom
      ? 'storage.unavailableBanner.missingCustom'
      : 'storage.unavailableBanner.uncreatableDefault';
  }
</script>

{#if status}
  <div class="vault-unavailable-banner" role="alert">
    <p class="vault-unavailable-text">
      <strong>{localizedText('storage.unavailableBanner.title')}</strong>
      {localizedText(reasonPath(status), { folderPath: status.displayPath })}
    </p>
    <button class="vault-unavailable-action" onclick={() => void chooseNotesDirectory()}>
      {localizedText('storage.unavailableBanner.chooseFolder')}
    </button>
  </div>
{/if}

<style>
  .vault-unavailable-banner {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 16px;
    background: var(--color-danger);
    color: #fff;
    font-size: 14px;
    line-height: 1.35;
  }

  .vault-unavailable-text {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .vault-unavailable-action {
    flex: none;
    appearance: none;
    cursor: pointer;
    padding: 6px 12px;
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-radius: 6px;
    background: transparent;
    color: #fff;
    font: inherit;
    font-weight: 600;
    white-space: nowrap;
  }

  .vault-unavailable-action:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .vault-unavailable-action:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
</style>
