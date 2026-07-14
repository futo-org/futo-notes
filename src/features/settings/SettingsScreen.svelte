<script lang="ts">
  import './settings.css';

  import { hasFileSystem, isDesktop } from '$lib/platform';
  import { resetAllNotes } from '$app/resetAllNotes';
  import { getCachedPreferences, savePreferences } from '$shared/state/appState';
  import { applyThemePreference, type ThemePreference } from '$features/system/theme';
  import type { SyncSummary } from '$features/sync/syncServiceE2ee';
  import { getSyncErrorMessage } from '$features/sync/syncErrorMessage';
  import { getAppVersion } from '$features/system/crashHandler';
  import { selfUpdateSupported, updaterSupported } from '$features/system/updater';
  import { updateChecker as upd } from '$features/system/updateChecker.svelte';
  import { confirmDialog } from '$shared/dialogs/confirmDialog';
  import { createSyncSettings } from './createSyncSettings.svelte';
  import AppearanceSettingsSection from './AppearanceSettingsSection.svelte';
  import BlockingSettingsOverlay from './BlockingSettingsOverlay.svelte';
  import CrashReportingSettingsSection from './CrashReportingSettingsSection.svelte';
  import DangerSettingsSection from './DangerSettingsSection.svelte';
  import DevSyncErrorSettingsSection from './DevSyncErrorSettingsSection.svelte';
  import StorageSettingsSection from './StorageSettingsSection.svelte';
  import SyncSettingsSection from './SyncSettingsSection.svelte';
  import UpdatesSettingsSection from './UpdatesSettingsSection.svelte';

  interface Props {
    onclose: () => void;
    syncError?: boolean;
    syncErrorMessage?: string;
    simulateSyncSummary?: (summary: SyncSummary, trigger?: 'manual') => void | Promise<void>;
  }

  let { onclose, syncError = false, syncErrorMessage = '', simulateSyncSummary }: Props = $props();

  let nuking = $state(false);
  let nukeError = $state('');

  const prefs = getCachedPreferences();
  let crashEnabled = $state(prefs.crashReporting.enabled);
  let crashAlwaysSend = $state(prefs.crashReporting.alwaysSend);
  let updatesEnabled = $state(prefs.updates.enabled);
  let themePreference = $state<ThemePreference>(prefs.appearance.theme);

  const sync = createSyncSettings();

  let overlayPressed = false;

  let notesDir = $state('');
  let isCustomDir = $state(false);
  let defaultNotesDir = $state('');
  if (isDesktop) {
    import('$lib/platform/tauri').then(({ getConfig }) =>
      getConfig().then((cfg) => {
        notesDir = cfg.notesDir;
        isCustomDir = cfg.isCustomDir;
        defaultNotesDir = cfg.defaultNotesDir;
      }),
    );
  }

  let showUpdates = $state(false);
  if (updaterSupported()) {
    if (import.meta.env.DEV) {
      showUpdates = true;
    } else {
      selfUpdateSupported().then((ok) => {
        showUpdates = ok;
      });
    }
  }

  async function handleChangeDir(): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== 'string') return;
    const confirmed = await confirmDialog(
      `Move your notes directory to:\n${picked}\n\nExisting notes in the current directory will NOT be moved. The app will restart.`,
      { title: 'Change notes directory', kind: 'warning' },
    );
    if (!confirmed) return;
    const { setNotesDir } = await import('$lib/platform/tauri');
    await setNotesDir(picked);
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }

  async function handleResetDir(): Promise<void> {
    const confirmed = await confirmDialog(
      `Reset notes directory to the default location?\n${defaultNotesDir}\n\nThe app will restart.`,
      { title: 'Reset notes directory', kind: 'warning' },
    );
    if (!confirmed) return;
    const { setNotesDir } = await import('$lib/platform/tauri');
    await setNotesDir(null);
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }

  const getErrorMessage = getSyncErrorMessage;

  async function toggleCrashEnabled(): Promise<void> {
    crashEnabled = !crashEnabled;
    if (!crashEnabled) crashAlwaysSend = false;
    const p = getCachedPreferences();
    p.crashReporting.enabled = crashEnabled;
    p.crashReporting.alwaysSend = crashAlwaysSend;
    await savePreferences(p);
  }

  async function toggleCrashAlwaysSend(): Promise<void> {
    crashAlwaysSend = !crashAlwaysSend;
    const p = getCachedPreferences();
    p.crashReporting.alwaysSend = crashAlwaysSend;
    await savePreferences(p);
  }

  const updatesLocked = $derived(upd.busy || upd.phase === 'restart');

  async function toggleUpdatesEnabled(): Promise<void> {
    if (updatesLocked) return;
    updatesEnabled = !updatesEnabled;
    const p = getCachedPreferences();
    p.updates.enabled = updatesEnabled;
    await savePreferences(p);
    if (updatesEnabled) void upd.start();
    else upd.disable();
  }

  async function setThemePreference(nextTheme: ThemePreference): Promise<void> {
    if (themePreference === nextTheme) return;
    themePreference = nextTheme;
    const p = getCachedPreferences();
    p.appearance.theme = nextTheme;
    await savePreferences(p);
    await applyThemePreference(nextTheme);
  }

  async function handleNukeTap(): Promise<void> {
    if (nuking) return;
    const confirmed = await confirmDialog(
      'Permanently delete all notes and app data? This cannot be undone.',
      { title: 'Full reset', kind: 'warning' },
    );
    if (!confirmed) return;
    await doNuke();
  }

  async function doNuke(): Promise<void> {
    nuking = true;
    nukeError = '';
    try {
      await resetAllNotes();
      window.location.reload();
    } catch (e) {
      nukeError = getErrorMessage(e);
    }
  }

  function cancelNuke(): void {
    nuking = false;
    nukeError = '';
  }
</script>

<div
  class="settings-overlay"
  role="button"
  tabindex="-1"
  onpointerdown={(e) => (overlayPressed = e.target === e.currentTarget)}
  onclick={() => overlayPressed && !sync.connecting && !nuking && onclose()}
  onkeydown={(e) => e.key === 'Escape' && !sync.connecting && !nuking && onclose()}
>
  <div
    class="settings-panel"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <!-- The scroller is a child so the blocking overlays (siblings below)
         anchor to the panel's VISIBLE box. When the panel itself scrolled,
         `inset: 0` resolved against the scrolled content box and the overlay
         could sit entirely off-screen — an invisible blocking state. -->
    <div class="settings-scroll">
      <div class="settings-header">
        <h2 class="settings-title">Settings</h2>
        {#if !sync.connecting && !nuking}
          <button class="settings-close" aria-label="Close settings" onclick={onclose}
            >&times;</button
          >
        {/if}
      </div>

      <div class="settings-content">
        {#if isDesktop && notesDir}
          <StorageSettingsSection
            notesDirectory={notesDir}
            isCustomDirectory={isCustomDir}
            onchange={() => void handleChangeDir()}
            onreset={() => void handleResetDir()}
          />
        {/if}

        <AppearanceSettingsSection
          preference={themePreference}
          onchange={(theme) => void setThemePreference(theme)}
        />

        {#if hasFileSystem}
          <SyncSettingsSection
            {sync}
            backgroundError={syncError}
            backgroundErrorMessage={syncErrorMessage}
          />
        {/if}

        {#if import.meta.env.DEV && simulateSyncSummary}
          <DevSyncErrorSettingsSection simulate={simulateSyncSummary} />
        {/if}

        <CrashReportingSettingsSection
          enabled={crashEnabled}
          alwaysSend={crashAlwaysSend}
          ontoggleenabled={() => void toggleCrashEnabled()}
          ontogglealwayssend={() => void toggleCrashAlwaysSend()}
        />

        {#if showUpdates}
          <UpdatesSettingsSection
            enabled={updatesEnabled}
            locked={updatesLocked}
            ontoggle={() => void toggleUpdatesEnabled()}
          />
        {/if}

        <DangerSettingsSection resetting={nuking} onreset={() => void handleNukeTap()} />
        <p class="settings-version">FUTO Notes v{getAppVersion()}</p>
      </div>
    </div>

    {#if sync.connecting}
      <BlockingSettingsOverlay
        error={sync.connectError}
        phase={sync.connectPhase}
        oncancel={sync.cancelConnect}
      />
    {/if}

    {#if nuking}
      <BlockingSettingsOverlay
        error={nukeError}
        phase="Deleting all notes..."
        oncancel={cancelNuke}
      />
    {/if}
  </div>
</div>
