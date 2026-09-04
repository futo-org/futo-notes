<script lang="ts">
  import { isTauri } from '$lib/platform';
  import { setNotesDir, vaultDisplayPath, vaultStatus } from '$lib/platform/tauri';
  import { applyThemePreference } from '$features/system/theme';
  import { getAppVersion } from '$features/system/crashHandler';
  import { updateChecker } from '$features/system/updateChecker.svelte';
  import { selfUpdateSupported, updaterSupported } from '$features/system/updater';
  import type { SyncSummary } from '$features/sync/syncServiceE2ee';
  import { confirmDialog } from '$shared/dialogs/confirmDialog';
  import { dismissable } from '$shared/dialogs/dismissable';
  import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
  import { desktopLocalization, localizedText } from '$shared/localization';
  import {
    getCachedPreferences,
    saveSelectedLanguageTag,
    savePreferences,
    type AppPreferences,
  } from '$shared/state/appState';

  import AppearanceSettingsSection from './AppearanceSettingsSection.svelte';
  import BlockingSettingsOverlay from './BlockingSettingsOverlay.svelte';
  import DangerSettingsSection from './DangerSettingsSection.svelte';
  import DevSyncErrorSettingsSection from './DevSyncErrorSettingsSection.svelte';
  import IssueReportingSettingsSection from './IssueReportingSettingsSection.svelte';
  import LanguageSettingsSection from './LanguageSettingsSection.svelte';
  import StorageSettingsSection from './StorageSettingsSection.svelte';
  import SyncSettingsSection from './SyncSettingsSection.svelte';
  import UpdatesSettingsSection from './UpdatesSettingsSection.svelte';
  import { createSyncSettings } from './createSyncSettings.svelte';
  import './settings.css';

  interface Props {
    onclose: () => void;
    backgroundSyncError: boolean;
    backgroundSyncErrorMessage: string;
    syncReconnecting: boolean;
    onsimulatesync: (summary: SyncSummary, trigger?: 'manual') => void | Promise<void>;
    onreset: () => Promise<void>;
  }

  let {
    onclose,
    backgroundSyncError,
    backgroundSyncErrorMessage,
    syncReconnecting,
    onsimulatesync,
    onreset,
  }: Props = $props();

  let preferences = $state<AppPreferences>(copyPreferences(getCachedPreferences()));
  let notesDirectoryPath = $state('');
  let notesDirectoryState = $state<'loading' | 'memory' | 'path' | 'error'>(
    isTauri ? 'loading' : 'memory',
  );
  let isCustomDirectory = $state(false);
  let vaultAvailable = $state(true);
  let resetting = $state(false);
  let resetFailed = $state(false);
  let updateSupported = $state(false);
  const sync = createSyncSettings();

  const notesDirectory = $derived.by(() => {
    if (notesDirectoryState === 'loading') return localizedText('settings.storage.loading');
    if (notesDirectoryState === 'memory') return localizedText('settings.storage.memoryVault');
    if (notesDirectoryState === 'error') return localizedText('settings.storage.unableToRead');
    return notesDirectoryPath;
  });

  const updateLocked = $derived(
    updateChecker.phase === 'downloading' ||
      updateChecker.phase === 'installing' ||
      updateChecker.phase === 'restart',
  );

  function copyPreferences(source: AppPreferences): AppPreferences {
    return {
      appearance: { ...source.appearance },
      language: { ...source.language },
      crashReporting: { ...source.crashReporting },
      updates: { ...source.updates },
      sync: { ...source.sync },
    };
  }

  function canClose(): boolean {
    return !resetting && !sync.connecting;
  }

  function close(): void {
    if (canClose()) onclose();
  }

  async function persistPreferences(): Promise<void> {
    preferences.language.selectedLanguageTag = desktopLocalization.selectedLanguageTag;
    await savePreferences(copyPreferences(preferences));
  }

  async function changeLanguage(selectedLanguageTag: string | null): Promise<void> {
    const acceptedLanguageTag = desktopLocalization.setSelectedLanguageTag(selectedLanguageTag);
    preferences.language.selectedLanguageTag = acceptedLanguageTag;
    try {
      await saveSelectedLanguageTag(acceptedLanguageTag);
    } catch (cause) {
      console.warn('Failed to save the selected language', cause);
      showGlobalToast({ path: 'settings.language.saveFailed' });
    }
  }

  function changeTheme(theme: AppPreferences['appearance']['theme']): void {
    preferences.appearance.theme = theme;
    void applyThemePreference(theme);
    void persistPreferences();
  }

  function toggleCrashReporting(): void {
    preferences.crashReporting.enabled = !preferences.crashReporting.enabled;
    if (!preferences.crashReporting.enabled) preferences.crashReporting.alwaysSend = false;
    void persistPreferences();
  }

  function toggleAlwaysSend(): void {
    preferences.crashReporting.alwaysSend = !preferences.crashReporting.alwaysSend;
    void persistPreferences();
  }

  function toggleUpdates(): void {
    if (updateLocked) return;
    preferences.updates.enabled = !preferences.updates.enabled;
    void persistPreferences();
    if (preferences.updates.enabled) void updateChecker.start();
    else updateChecker.disable();
  }

  async function chooseNotesDirectory(): Promise<void> {
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

  async function resetNotesDirectory(): Promise<void> {
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

  async function confirmFullReset(): Promise<void> {
    const confirmed = await confirmDialog(localizedText('settings.danger.confirmation'), {
      title: localizedText('settings.danger.fullReset'),
      kind: 'warning',
    });
    if (!confirmed) return;

    resetting = true;
    resetFailed = false;
    try {
      await onreset();
    } catch (cause) {
      console.error('Full reset failed', cause);
      resetFailed = true;
      resetting = false;
    }
  }

  if (isTauri) {
    // Read the vault's *location*, not the vault: `vaultStatus` answers for a
    // folder that has gone missing too, where reading the config would leave
    // "Reset to default" hidden precisely when the vault is broken — exactly
    // when the user needs it.
    void vaultStatus()
      .then((status) => {
        notesDirectoryPath = status.displayPath;
        notesDirectoryState = 'path';
        isCustomDirectory = status.isCustom;
        vaultAvailable = status.available;
      })
      .catch((error) => {
        notesDirectoryState = 'error';
        console.warn('Failed to read notes directory:', error);
      });
  }
  if (updaterSupported() && import.meta.env.DEV) {
    // Show the Updates section in desktop dev builds for manual testing, even
    // though the packaged updater reports unsupported there.
    updateSupported = true;
  } else {
    void selfUpdateSupported().then((supported) => {
      updateSupported = supported;
    });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="settings-overlay"
  role="presentation"
  use:dismissable={{ ondismiss: close }}
  onclick={close}
>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="settings-panel"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
  >
    <div class="settings-scroll">
      <header class="settings-header">
        <h2 class="settings-title">{localizedText('settings.heading')}</h2>
        <button
          class="settings-close"
          aria-label={localizedText('settings.closeAccessibilityLabel')}
          onclick={close}>×</button
        >
      </header>

      <div class="settings-content">
        <StorageSettingsSection
          {notesDirectory}
          {isCustomDirectory}
          {vaultAvailable}
          onchange={() => void chooseNotesDirectory()}
          onreset={() => void resetNotesDirectory()}
        />
        <AppearanceSettingsSection
          preference={preferences.appearance.theme}
          onchange={changeTheme}
        />
        <LanguageSettingsSection
          selectedLanguageTag={desktopLocalization.selectedLanguageTag}
          languages={desktopLocalization.availableLanguages}
          onchange={(selectedLanguageTag) => void changeLanguage(selectedLanguageTag)}
        />
        <SyncSettingsSection
          {sync}
          backgroundError={backgroundSyncError}
          backgroundErrorMessage={backgroundSyncErrorMessage}
          reconnecting={syncReconnecting}
        />
        <IssueReportingSettingsSection
          enabled={preferences.crashReporting.enabled}
          alwaysSend={preferences.crashReporting.alwaysSend}
          ontoggleenabled={toggleCrashReporting}
          ontogglealwayssend={toggleAlwaysSend}
        />
        {#if updateSupported}
          <UpdatesSettingsSection
            enabled={preferences.updates.enabled}
            locked={updateLocked}
            ontoggle={toggleUpdates}
          />
        {/if}
        {#if import.meta.env.DEV}
          <DevSyncErrorSettingsSection simulate={onsimulatesync} />
        {/if}
        <DangerSettingsSection {resetting} onreset={() => void confirmFullReset()} />
        <div class="settings-version">
          {localizedText('settings.about.versionLine', { version: getAppVersion() })}
        </div>
      </div>
    </div>

    {#if sync.connecting}
      <BlockingSettingsOverlay
        phase={sync.connectPhase}
        error={sync.connectError}
        oncancel={sync.cancelConnect}
      />
    {:else if resetting}
      <BlockingSettingsOverlay phase={localizedText('settings.danger.deleting')} />
    {:else if resetFailed}
      <BlockingSettingsOverlay
        phase=""
        error={localizedText('settings.danger.failed')}
        oncancel={() => {
          resetFailed = false;
        }}
      />
    {/if}
  </div>
</div>
