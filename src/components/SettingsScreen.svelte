<script lang="ts">
  import { hasFileSystem, isDesktop } from '$lib/platform';
  import { deleteAllNotes } from '$lib/notes.svelte';
  import { getAppState, getCachedPreferences, savePreferences } from '$lib/appState';
  import { applyThemePreference, type ThemePreference } from '$lib/theme';
  import { connectE2ee, disconnectE2ee, hasStoredSyncPassword, forgetStoredSyncPassword, setSyncProgressListener } from '$lib/syncServiceE2ee';
  import { requestSyncV2 } from '$lib/autoSyncV2';
  import { getSyncErrorMessage } from '$lib/syncErrorMessage';
  import { getAppVersion } from '$lib/crashHandler';
  import { showGlobalToast } from '$lib/toast';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { formatRelativeTime } from '$lib/utils';

  interface Props {
    onclose: () => void;
    onimported: (count: number) => void;
    /** F15: live auto/background sync failure from the sync manager. Shown in
     *  the sync section so background errors surface without opening the bar's
     *  hover tooltip. Cleared by the manager on the next successful sync. */
    syncError?: boolean;
    syncErrorMessage?: string;
  }

  let { onclose, onimported, syncError = false, syncErrorMessage = '' }: Props = $props();

  let nuking = $state(false);
  let nukeConfirm = $state(false);
  let nukeError = $state('');

  // Crash reporting preferences
  const prefs = getCachedPreferences();
  let crashEnabled = $state(prefs.crashReporting.enabled);
  let crashAlwaysSend = $state(prefs.crashReporting.alwaysSend);
  let themePreference = $state<ThemePreference>(prefs.appearance.theme);

  // Sync MVP preferences
  const appState = getAppState();
  let syncUrl = $state(appState.e2eeServerUrl || (import.meta.env.DEV && !appState.e2eeAuthToken ? 'http://127.0.0.1:3100' : ''));
  let syncPassword = $state('');
  let syncBusy = $state(false);
  let syncStatus = $state(prefs.sync.lastError ? `Last error: ${prefs.sync.lastError}` : '');
  let syncLastAt = $state<number | null>(prefs.sync.lastSyncedAt);
  let hasSyncToken = $state(Boolean(appState.e2eeAuthToken));
  let passwordSaved = $state(hasStoredSyncPassword());

  // Connect + sync blocking modal
  let connectSyncing = $state(false);
  let connectSyncPhase = $state('');
  let connectSyncError = $state('');

  // Desktop: notes directory
  let notesDir = $state('');
  let isCustomDir = $state(false);
  let defaultNotesDir = $state('');
  if (isDesktop) {
    import('$lib/platform/tauri').then(({ getConfig }) =>
      getConfig().then((cfg) => {
        notesDir = cfg.notesDir;
        isCustomDir = cfg.isCustomDir;
        defaultNotesDir = cfg.defaultNotesDir;
      })
    );
  }

  async function handleChangeDir(): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== 'string') return;
    const confirmed = await ask(
      `Move your notes directory to:\n${picked}\n\nExisting notes in the current directory will NOT be moved. The app will restart.`,
      { title: 'Change notes directory', kind: 'warning' }
    );
    if (!confirmed) return;
    const { setNotesDir } = await import('$lib/platform/tauri');
    await setNotesDir(picked);
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }

  async function handleResetDir(): Promise<void> {
    const confirmed = await ask(
      `Reset notes directory to the default location?\n${defaultNotesDir}\n\nThe app will restart.`,
      { title: 'Reset notes directory', kind: 'warning' }
    );
    if (!confirmed) return;
    const { setNotesDir } = await import('$lib/platform/tauri');
    await setNotesDir(null);
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }

  const getErrorMessage = getSyncErrorMessage;

  async function persistSyncUrl(): Promise<void> {
    // URL is persisted as part of connectE2ee state
  }

  async function handleConnectSync(): Promise<void> {
    if (syncBusy) return;
    syncBusy = true;
    connectSyncing = true;
    connectSyncPhase = 'Connecting to server...';
    connectSyncError = '';
    try {
      await connectE2ee(syncUrl, syncPassword);
      hasSyncToken = true;
      passwordSaved = hasStoredSyncPassword();

      connectSyncPhase = 'Syncing notes...';
      // Route through requestSyncV2 so autoSyncV2's onSyncComplete fires —
      // that's what triggers the notes-list refresh after new files land.
      // connectE2ee has already cached the vault key, so no password needed.
      setSyncProgressListener((p) => {
        const label = p.phase === 'reconciling' ? 'Reconciling'
          : p.phase === 'pushing' ? 'Uploading'
          : 'Downloading';
        connectSyncPhase = `${label} ${p.current}/${p.total}…`;
      });
      let summary;
      try {
        summary = await requestSyncV2();
      } finally {
        setSyncProgressListener(null);
      }
      syncPassword = '';

      const updatedPrefs = getCachedPreferences();
      syncLastAt = updatedPrefs.sync.lastSyncedAt;
      syncStatus = '';

      connectSyncing = false;
      const parts: string[] = [];
      if (summary.downloaded) parts.push(`${summary.downloaded} downloaded`);
      if (summary.uploaded) parts.push(`${summary.uploaded} uploaded`);
      showGlobalToast(parts.length ? `Synced: ${parts.join(', ')}` : 'Sync complete — everything up to date');
    } catch (e) {
      console.error('[e2ee] connect/sync failed:', e);
      connectSyncError = getErrorMessage(e);
      if (!hasSyncToken) {
        syncStatus = `Connect failed: ${connectSyncError}`;
      } else {
        syncStatus = `Sync failed: ${connectSyncError}`;
      }
    } finally {
      syncBusy = false;
    }
  }

  function cancelConnectSync(): void {
    connectSyncing = false;
    connectSyncError = '';
  }

  async function confirmResetConnection(): Promise<void> {
    const confirmed = await ask('Are you sure you want to reset the connection?', { title: 'Reset connection', kind: 'warning' });
    if (!confirmed) return;
    hasSyncToken = false;
    syncPassword = '';
    syncStatus = '';
    await disconnectE2ee();
    passwordSaved = false;
  }

  async function handleForgetPassword(): Promise<void> {
    const confirmed = await ask(
      'Forget the saved sync password? You will be asked to re-enter it to sync after the next restart.',
      { title: 'Forget password', kind: 'warning' }
    );
    if (!confirmed) return;
    await forgetStoredSyncPassword();
    passwordSaved = false;
  }

  function handleUrlClick(): void {
    if (hasSyncToken) {
      void confirmResetConnection();
    }
  }

  async function handleSyncNow(): Promise<void> {
    if (syncBusy) return;
    syncBusy = true;
    syncStatus = 'Syncing...';
    try {
      await persistSyncUrl();
      if (syncPassword) {
        syncPassword = '';
      }
      await requestSyncV2();
      const updatedPrefs = getCachedPreferences();
      hasSyncToken = Boolean(getAppState().e2eeAuthToken);
      syncLastAt = updatedPrefs.sync.lastSyncedAt;
      syncStatus = 'Sync complete';
    } catch (e) {
      syncStatus = `Sync failed: ${getErrorMessage(e)}`;
    } finally {
      syncBusy = false;
    }
  }

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

  async function setThemePreference(nextTheme: ThemePreference): Promise<void> {
    if (themePreference === nextTheme) return;
    themePreference = nextTheme;
    const p = getCachedPreferences();
    p.appearance.theme = nextTheme;
    await savePreferences(p);
    await applyThemePreference(nextTheme);
  }

  function handleNukeTap(): void {
    if (nuking) return;
    if (!nukeConfirm) {
      nukeConfirm = true;
      return;
    }
    void doNuke();
  }

  async function doNuke(): Promise<void> {
    nuking = true;
    nukeError = '';
    try {
      await deleteAllNotes();
      // Reload flushes every in-memory cache; disk state was cleared by
      // deleteAllContent(), so the fresh boot starts from defaults.
      window.location.reload();
    } catch (e) {
      nukeError = getErrorMessage(e);
    }
  }

  function cancelNuke(): void {
    nuking = false;
    nukeConfirm = false;
    nukeError = '';
  }

  function testCrash(): void {
    throw new Error('Test crash from Settings');
  }
</script>

<div class="settings-overlay" role="button" tabindex="-1" onclick={() => !connectSyncing && !nuking && onclose()} onkeydown={(e) => e.key === 'Escape' && !connectSyncing && !nuking && onclose()}>
  <div class="settings-panel" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <div class="settings-header">
      <h2 class="settings-title">Settings</h2>
      {#if !connectSyncing && !nuking}
        <button class="settings-close" aria-label="Close settings" onclick={onclose}>&times;</button>
      {/if}
    </div>

    <div class="settings-content">
      {#if isDesktop && notesDir}
      <section class="settings-section">
        <h3 class="settings-section-title">Storage</h3>
        <div class="settings-card">
          <p class="settings-btn-desc">{notesDir}</p>
          <div class="settings-actions" style="margin-top: 10px">
            <button class="settings-btn settings-btn-inline" onclick={() => void handleChangeDir()}>Change directory</button>
          </div>
          {#if isCustomDir}
            <button class="settings-link-btn" onclick={() => void handleResetDir()}>Reset to default</button>
          {/if}
        </div>
      </section>
      {/if}

      <section class="settings-section">
        <h3 class="settings-section-title">Appearance</h3>
        <div class="settings-card">
          <div class="settings-segmented" role="tablist" aria-label="Theme">
            <button
              class="settings-segment"
              class:active={themePreference === 'auto'}
              onclick={() => void setThemePreference('auto')}
              aria-pressed={themePreference === 'auto'}
            >Auto</button>
            <button
              class="settings-segment"
              class:active={themePreference === 'dark'}
              onclick={() => void setThemePreference('dark')}
              aria-pressed={themePreference === 'dark'}
            >Dark</button>
            <button
              class="settings-segment"
              class:active={themePreference === 'light'}
              onclick={() => void setThemePreference('light')}
              aria-pressed={themePreference === 'light'}
            >Light</button>
          </div>
          <p class="settings-btn-desc settings-hint">Auto follows your system theme.</p>
        </div>
      </section>

      {#if hasFileSystem}
      <section class="settings-section">
        <h3 class="settings-section-title">Sync</h3>
        <div class="settings-card">
          <label class="settings-input-label" for="sync-url">Server URL</label>
          <input
            id="sync-url"
            class="settings-input"
            class:settings-input-readonly={hasSyncToken}
            type="text"
            bind:value={syncUrl}
            onblur={persistSyncUrl}
            onclick={handleUrlClick}
            readonly={hasSyncToken}
            placeholder="notes.example.com"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
          />

          {#if !hasSyncToken}
            <label class="settings-input-label" for="sync-password">Password</label>
            <input
              id="sync-password"
              class="settings-input"
              type="password"
              bind:value={syncPassword}
              placeholder="Server password"
              autocapitalize="off"
              autocomplete="current-password"
              spellcheck="false"
            />

            <p class="settings-btn-desc settings-hint">
              Use the password you configured when installing your FUTO Notes server.
            </p>

            <div class="settings-actions">
              <button class="settings-btn settings-btn-inline" onclick={handleConnectSync} disabled={syncBusy}>
                {syncBusy ? 'Working...' : 'Connect'}
              </button>
            </div>
          {:else}
            {#if !passwordSaved}
              <label class="settings-input-label" for="sync-password">Vault password</label>
              <input
                id="sync-password"
                class="settings-input"
                type="password"
                bind:value={syncPassword}
                placeholder="Required after restart"
                autocapitalize="off"
                autocomplete="current-password"
                spellcheck="false"
              />
            {:else}
              <p class="settings-btn-desc settings-hint">Password saved on this device.</p>
            {/if}

            <div class="settings-actions">
              <button class="settings-btn settings-btn-inline" onclick={handleSyncNow} disabled={syncBusy}>
                {syncBusy ? 'Working...' : 'Sync now'}
              </button>
            </div>

            {#if passwordSaved}
              <button class="settings-link-btn" onclick={() => void handleForgetPassword()}>Forget password</button>
            {/if}
            <button class="settings-link-btn" onclick={() => void confirmResetConnection()}>Reset connection</button>
          {/if}

          <p class="settings-btn-desc settings-hint">Last sync: {syncLastAt ? formatRelativeTime(syncLastAt) : 'never'}</p>
          {#if syncStatus}
            <p class="settings-btn-desc settings-hint">{syncStatus}</p>
          {:else if syncError}
            <!-- F15: live auto/background sync failure (no manual status taking
                 precedence). Mirrors the status-bar error indicator wording. -->
            <p class="settings-btn-desc settings-hint">Sync failed: {syncErrorMessage}</p>
          {/if}
        </div>
      </section>
      {/if}

      <section class="settings-section">
        <h3 class="settings-section-title">Crash Reporting</h3>
        <div class="settings-toggle-row" onclick={toggleCrashEnabled} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && toggleCrashEnabled()}>
          <span class="settings-toggle-text">
            <span class="settings-btn-label">Share crash reports</span>
            <span class="settings-btn-desc">Help improve FUTO Notes by sharing anonymous crash logs when they occur</span>
          </span>
          <div class="settings-switch" class:on={crashEnabled}>
            <div class="settings-switch-thumb"></div>
          </div>
        </div>
        {#if crashEnabled}
          <div class="settings-toggle-row sub" onclick={toggleCrashAlwaysSend} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && toggleCrashAlwaysSend()}>
            <span class="settings-toggle-text">
              <span class="settings-btn-label">Always send automatically</span>
              <span class="settings-btn-desc">Send reports without asking each time</span>
            </span>
            <div class="settings-switch" class:on={crashAlwaysSend}>
              <div class="settings-switch-thumb"></div>
            </div>
          </div>
        {/if}
      </section>

      <section class="settings-section">
        <h3 class="settings-section-title">Danger zone</h3>
        <button class="settings-btn settings-btn-danger" onclick={handleNukeTap} disabled={nuking}>
          <span class="settings-btn-text">
            <span class="settings-btn-label">
              {#if nukeConfirm}
                Tap again to confirm
              {:else}
                Full reset
              {/if}
            </span>
            <span class="settings-btn-desc">
              {#if nuking}
                Deleting...
              {:else if nukeConfirm}
                This cannot be undone!
              {:else}
                Permanently remove all notes and app data
              {/if}
            </span>
          </span>
        </button>
        {#if import.meta.env.DEV}
          <button class="settings-btn settings-btn-danger" style="margin-top: 8px" onclick={testCrash}>
            <span class="settings-btn-text">
              <span class="settings-btn-label">Test crash</span>
              <span class="settings-btn-desc">Throw an error to test crash reporting</span>
            </span>
          </button>
        {/if}
      </section>

      <p class="settings-version">FUTO Notes v{getAppVersion()}</p>
    </div>

    {#if connectSyncing}
      <div class="connect-sync-overlay">
        {#if connectSyncError}
          <div class="connect-sync-error">{connectSyncError}</div>
          <button class="connect-sync-cancel" onclick={cancelConnectSync}>Close</button>
        {:else}
          <div class="connect-sync-spinner"></div>
          <div class="connect-sync-phase">{connectSyncPhase}</div>
        {/if}
      </div>
    {/if}

    {#if nuking}
      <div class="connect-sync-overlay">
        {#if nukeError}
          <div class="connect-sync-error">{nukeError}</div>
          <button class="connect-sync-cancel" onclick={cancelNuke}>Close</button>
        {:else}
          <div class="connect-sync-spinner"></div>
          <div class="connect-sync-phase">Deleting all notes...</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(var(--ink-rgb), 0.35);
    z-index: 200;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .settings-panel {
    position: relative;
    width: 100%;
    max-width: 600px;
    max-height: 85vh;
    background: var(--color-bg);
    border-radius: 16px 16px 0 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: max(16px, env(safe-area-inset-bottom));
  }

  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 20px 12px;
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--color-bg);
  }

  .settings-title {
    font-size: 20px;
    font-weight: 600;
    margin: 0;
    color: var(--color-text);
  }

  .settings-close {
    width: 36px;
    height: 36px;
    border: none;
    background: var(--color-surface);
    border-radius: 10px;
    font-size: 22px;
    line-height: 1;
    padding: 0 0 4px;
    color: var(--color-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.15s ease;
  }

  .settings-close:active {
    background: var(--color-border);
  }

  .settings-content {
    padding: 0 20px;
  }

  .settings-section {
    margin-bottom: 24px;
  }

  .settings-section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-muted);
    margin: 0 0 8px 4px;
  }

  .settings-card {
    background: var(--color-surface);
    border-radius: 12px;
    padding: 14px;
  }

  .settings-segmented {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
  }

  .settings-segment {
    border: none;
    border-radius: 9px;
    background: transparent;
    color: var(--color-muted);
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    padding: 9px 8px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .settings-segment:active {
    background: rgba(var(--primary-rgb), 0.12);
  }

  .settings-segment.active {
    background: var(--color-primary);
    color: var(--color-bg);
  }

  .settings-input-label {
    display: block;
    margin: 2px 2px 6px;
    font-size: 13px;
    color: var(--color-muted);
  }

  .settings-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-text);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 14px;
    font-family: inherit;
    margin-bottom: 10px;
  }

  .settings-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .settings-input-readonly {
    opacity: 0.7;
    cursor: pointer;
  }

  .settings-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
    margin-bottom: 6px;
  }

  .settings-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border: none;
    background: var(--color-surface);
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.1s ease;
  }

  .settings-btn-inline {
    flex: 1;
    background: var(--color-text);
    color: var(--color-bg);
    justify-content: center;
    padding: 10px 12px;
    font-weight: 500;
    border-radius: 10px;
  }

  .settings-btn:active {
    transform: scale(0.98);
  }

  .settings-btn:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .settings-btn:disabled:active {
    transform: none;
  }

  .settings-btn-danger .settings-btn-label {
    color: var(--color-danger);
  }

  .settings-btn-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .settings-btn-label {
    font-size: 16px;
    font-weight: 500;
    color: var(--color-text);
  }

  .settings-btn-desc {
    font-size: 13px;
    color: var(--color-muted);
  }

  .settings-hint {
    margin: 6px 0;
    line-height: 1.35;
  }

  .settings-link-btn {
    display: block;
    margin: 6px 0 2px;
    padding: 0;
    border: none;
    background: none;
    color: var(--color-muted);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    text-decoration: underline;
    -webkit-tap-highlight-color: transparent;
  }

  .settings-link-btn:active {
    opacity: 0.6;
  }

  .settings-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    background: var(--color-surface);
    border-radius: 12px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    margin-bottom: 2px;
    transition: transform 0.1s ease;
  }

  .settings-toggle-row:active {
    transform: scale(0.98);
  }

  .settings-toggle-row.sub {
    padding-left: 24px;
    border-radius: 0 0 12px 12px;
    margin-top: 0;
  }

  .settings-toggle-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .settings-switch {
    width: 48px;
    height: 28px;
    border-radius: 14px;
    background: var(--color-border);
    position: relative;
    transition: background 0.2s ease;
    flex-shrink: 0;
    margin-left: 12px;
  }

  .settings-switch.on {
    background: var(--color-primary);
  }

  .settings-switch-thumb {
    width: 24px;
    height: 24px;
    border-radius: 12px;
    background: var(--color-bg);
    position: absolute;
    top: 2px;
    left: 2px;
    transition: transform 0.2s ease;
    box-shadow: 0 1px 3px rgba(var(--ink-rgb), 0.15);
  }

  .settings-switch.on .settings-switch-thumb {
    transform: translateX(20px);
  }

  /* Connect + sync blocking overlay */
  .connect-sync-overlay {
    position: absolute;
    inset: 0;
    background: var(--color-bg);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    border-radius: 16px 16px 0 0;
    z-index: 10;
  }

  .connect-sync-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: connect-spin 0.8s linear infinite;
  }

  @keyframes connect-spin {
    to { transform: rotate(360deg); }
  }

  .connect-sync-phase {
    font-size: 15px;
    color: var(--color-muted);
    /* Lock digit width so X/Y doesn't shimmy as the counter advances. */
    font-variant-numeric: tabular-nums;
  }

  .connect-sync-error {
    font-size: 14px;
    color: var(--color-danger);
    text-align: center;
    padding: 0 24px;
    line-height: 1.4;
  }

  .connect-sync-cancel {
    border: none;
    background: var(--color-surface);
    color: var(--color-text);
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    padding: 10px 24px;
    border-radius: 10px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .connect-sync-cancel:active {
    opacity: 0.7;
  }

  .settings-version {
    text-align: center;
    font-size: 12px;
    color: var(--color-muted);
    margin: 16px 0 8px;
  }
</style>
