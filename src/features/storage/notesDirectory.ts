import { isTauri } from '$lib/platform';
import { setNotesDir, vaultDisplayPath } from '$lib/platform/tauri';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import { localizedText } from '$shared/localization';

export async function chooseNotesDirectory(): Promise<void> {
  if (!isTauri) return;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected !== 'string') return;
  try {
    // Name the folder the user picked, not the `/run/user/1000/doc/…` path a
    // sandboxed file chooser hands back. Read-only on purpose: the lasting
    // document-portal grant is minted by `setNotesDir` below, so a cancelled
    // dialog leaves nothing behind.
    const confirmed = await confirmDialog(
      localizedText('settings.dialogs.changeDirectoryConfirmation', {
        directory: await vaultDisplayPath(selected),
      }),
      { title: localizedText('settings.dialogs.changeDirectoryTitle'), kind: 'warning' },
    );
    if (!confirmed) return;
    await setNotesDir(selected);
    await restartForNewVault();
  } catch (cause) {
    // Picking a folder and having nothing happen is the worst outcome here, and
    // every step above can fail: an unusable grant, a folder that cannot be
    // created, a refused relaunch.
    console.warn('Failed to change notes directory', cause);
    showGlobalToast({ path: 'settings.storage.useFolderFailed' });
  }
}

export async function resetNotesDirectory(): Promise<void> {
  if (!isTauri) return;
  const confirmed = await confirmDialog(
    localizedText('settings.dialogs.resetDirectoryConfirmation'),
    { title: localizedText('settings.dialogs.resetDirectoryTitle'), kind: 'warning' },
  );
  if (!confirmed) return;
  await setNotesDir(null);
  await restartForNewVault();
}

// Relaunch, not window.location.reload(): the Rust fs watcher binds the vault
// root once at startup, so only a full process restart rebinds it to the new
// vault. A webview reload would leave the watcher on the old root. See sync.md.
async function restartForNewVault(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
