import { throughConfirmation } from '$app/puppet/puppetConfirm';
import { puppetRefusal, type Args, type PuppetOutcome } from '$app/puppet/puppetRegistry';
import { isTauri } from '$lib/platform';
import { puppetNotesDirRefusal, setNotesDir, vaultDisplayPath } from '$lib/platform/tauri';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { flushPendingSaveBeforeExit } from '$shared/lifecycle/flushBeforeExit';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import { localizedText } from '$shared/localization';

// A `chosen` path arrives from the agent's SetNotesDirectory in place of the
// OS folder picker, which is outside the app; the confirmation is the app's own.
export async function chooseNotesDirectory(chosen?: string): Promise<void> {
  if (!isTauri) return;
  let selected = chosen ?? null;
  if (selected === null) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== 'string') return;
    selected = picked;
  }
  try {
    // Name the folder the user picked, not the `/run/user/1000/doc/…` path a
    // sandboxed file chooser hands back. Read-only on purpose: the lasting
    // document-portal grant is minted by `setNotesDir` below, so a canceled
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

/**
 * SetNotesDirectory's run: `path` is the folder the OS picker would return. A dev build
 * must never be pointed at another vault (AGENTS.md M3), and the agent never gets the
 * picker's implicit "the user chose this", so Rust refuses any path that does not resolve
 * inside this checkout's data folder.
 */
export async function chooseNotesDirectoryVerb(args: Args): Promise<PuppetOutcome | undefined> {
  const path = args.path as string;
  const refusal = await puppetNotesDirRefusal(path);
  if (refusal) return puppetRefusal(403, refusal);
  return throughConfirmation(() => chooseNotesDirectory(path));
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
  // A relaunch is not a window close, so it drains the pending save itself (RC-87).
  await flushPendingSaveBeforeExit();
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
