<script lang="ts">
  import { isTauri } from '$lib/platform';
  import { getConfig, setNotesDir } from '$lib/platform/tauri';
  import { applyThemePreference, watchSystemTheme } from '$features/system/theme';
  import { getAppVersion } from '$features/system/crashHandler';
  import { updateChecker } from '$features/system/updateChecker.svelte';
  import { selfUpdateSupported } from '$features/system/updater';
  import type { SyncSummary } from '$features/sync/syncServiceE2ee';
  import { confirmDialog } from '$shared/dialogs/confirmDialog';
  import {
    getCachedPreferences,
    savePreferences,
    type AppPreferences,
  } from '$shared/state/appState';

  import AppearanceSettingsSection from './AppearanceSettingsSection.svelte';
  import BlockingSettingsOverlay from './BlockingSettingsOverlay.svelte';
  import CrashReportingSettingsSection from './CrashReportingSettingsSection.svelte';
  import DangerSettingsSection from './DangerSettingsSection.svelte';
  import DevSyncErrorSettingsSection from './DevSyncErrorSettingsSection.svelte';
  import StorageSettingsSection from './StorageSettingsSection.svelte';
  import SyncSettingsSection from './SyncSettingsSection.svelte';
  import UpdatesSettingsSection from './UpdatesSettingsSection.svelte';
  import { createSyncSettings } from './createSyncSettings.svelte';
  import './settings.css';

  interface Props {
    onclose: () => void;
    backgroundSyncError: boolean;
    backgroundSyncErrorMessage: string;
    onsimulatesync: (summary: SyncSummary, trigger?: 'manual') => void | Promise<void>;
    onreset: () => Promise<void>;
  }

  let { onclose, backgroundSyncError, backgroundSyncErrorMessage, onsimulatesync, onreset }: Props =
    $props();

  let preferences = $state<AppPreferences>(copyPreferences(getCachedPreferences()));
  let notesDirectory = $state(isTauri ? 'Loading…' : 'In-memory test vault');
  let isCustomDirectory = $state(false);
  let resetting = $state(false);
  let resetError = $state('');
  let updateSupported = $state(false);
  const sync = createSyncSettings();

  const updateLocked = $derived(
    updateChecker.phase === 'downloading' ||
      updateChecker.phase === 'installing' ||
      updateChecker.phase === 'restart',
  );

  function copyPreferences(source: AppPreferences): AppPreferences {
    return {
      appearance: { ...source.appearance },
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
    await savePreferences(copyPreferences(preferences));
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
    await setNotesDir(selected);
    window.location.reload();
  }

  async function resetNotesDirectory(): Promise<void> {
    await setNotesDir(null);
    window.location.reload();
  }

  async function confirmFullReset(): Promise<void> {
    const confirmed = await confirmDialog(
      'Permanently delete all notes and app data? This cannot be undone.',
      { title: 'Full reset', kind: 'warning' },
    );
    if (!confirmed) return;

    resetting = true;
    resetError = '';
    try {
      await onreset();
    } catch (error) {
      resetError = error instanceof Error ? error.message : String(error);
      resetting = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  if (isTauri) {
    void getConfig()
      .then((config) => {
        notesDirectory = config.notesDir;
        isCustomDirectory = config.isCustomDir;
      })
      .catch((error) => {
        notesDirectory = 'Unable to read notes directory';
        console.warn('Failed to read notes directory:', error);
      });
  }
  void selfUpdateSupported().then((supported) => {
    updateSupported = supported;
  });

  $effect(() => {
    if (preferences.appearance.theme !== 'auto') return;
    return watchSystemTheme(() => void applyThemePreference('auto'));
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="settings-overlay" role="presentation" onclick={close}>
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
        <h2 class="settings-title">Settings</h2>
        <button class="settings-close" aria-label="Close settings" onclick={close}>×</button>
      </header>

      <div class="settings-content">
        <StorageSettingsSection
          {notesDirectory}
          {isCustomDirectory}
          onchange={() => void chooseNotesDirectory()}
          onreset={() => void resetNotesDirectory()}
        />
        <AppearanceSettingsSection
          preference={preferences.appearance.theme}
          onchange={changeTheme}
        />
        <SyncSettingsSection
          {sync}
          backgroundError={backgroundSyncError}
          backgroundErrorMessage={backgroundSyncErrorMessage}
        />
        <CrashReportingSettingsSection
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
        <div class="settings-version">FUTO Notes v{getAppVersion()}</div>
      </div>
    </div>

    {#if sync.connecting}
      <BlockingSettingsOverlay
        phase={sync.connectPhase}
        error={sync.connectError}
        oncancel={sync.cancelConnect}
      />
    {:else if resetting}
      <BlockingSettingsOverlay phase="Deleting all notes…" />
    {:else if resetError}
      <BlockingSettingsOverlay
        phase=""
        error={`Full reset failed: ${resetError}`}
        oncancel={() => {
          resetError = '';
        }}
      />
    {/if}
  </div>
</div>
