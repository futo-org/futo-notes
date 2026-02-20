<script lang="ts">
  import { hasFileSystem, isMobile, isElectron } from '$lib/platform';
  import { createNote, getAllNotes, deleteNote, deleteAllNotes } from '$lib/notes';
  import { sanitizeFilename } from '$lib/utils';
  import { getCachedPreferences, savePreferences } from '$lib/preferences';
  import { connectSyncServer, saveSyncServerUrl, type SyncSummary } from '$lib/sync';
  import { requestSync } from '$lib/autoSync';

  interface ImportedFile {
    name: string;
    path: string;
    content: string;
    lastModified?: number;
  }

  interface FolderImportPlugin {
    pickAndReadMarkdownFiles(): Promise<{ files: ImportedFile[] }>;
    setFileModificationTime(options: { filename: string; mtime: number }): Promise<void>;
  }

  let FolderImport: FolderImportPlugin | null = null;
  if (isMobile) {
    import('@capacitor/core').then(({ registerPlugin }) => {
      FolderImport = registerPlugin<FolderImportPlugin>('FolderImport');
    });
  }

  interface Props {
    onclose: () => void;
    onimported: (count: number) => void;
    onsynccomplete: (summary: SyncSummary) => void;
  }

  let { onclose, onimported, onsynccomplete }: Props = $props();

  let importing = $state(false);
  let importStatus = $state('');
  let nuking = $state(false);
  let nukeConfirm = $state(false);

  // Crash reporting preferences
  const prefs = getCachedPreferences();
  let crashEnabled = $state(prefs.crashReporting.enabled);
  let crashAlwaysSend = $state(prefs.crashReporting.alwaysSend);

  // Sync MVP preferences
  let syncUrl = $state(prefs.sync.serverUrl);
  let syncPassword = $state('');
  let syncBusy = $state(false);
  let syncStatus = $state(prefs.sync.lastError ? `Last error: ${prefs.sync.lastError}` : '');
  let syncLastAt = $state<number | null>(prefs.sync.lastSyncedAt);
  let hasSyncToken = $state(Boolean(prefs.sync.token));
  let tokenServerUrl = $state(prefs.sync.serverUrl);

  // Electron: notes directory
  let notesDir = $state('');
  if (isElectron) {
    import('$lib/platform/electron').then(({ getConfig }) =>
      getConfig().then((cfg) => { notesDir = cfg.notesDir; })
    );
  }

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function formatTimestamp(ts: number | null): string {
    return ts ? new Date(ts).toLocaleString() : 'never';
  }

  async function persistSyncUrl(): Promise<void> {
    await saveSyncServerUrl(syncUrl);
  }

  async function handleConnectSync(): Promise<void> {
    if (syncBusy) return;
    syncBusy = true;
    syncStatus = 'Connecting...';
    try {
      await connectSyncServer(syncUrl, syncPassword);
      hasSyncToken = true;
      tokenServerUrl = syncUrl;
      syncPassword = '';
      syncStatus = 'Connected. You can sync now.';
    } catch (e) {
      syncStatus = `Connect failed: ${getErrorMessage(e)}`;
    } finally {
      syncBusy = false;
    }
  }

  async function handleSyncNow(): Promise<void> {
    if (syncBusy) return;
    syncBusy = true;
    syncStatus = 'Syncing...';
    try {
      await persistSyncUrl();
      await requestSync();
      const updatedPrefs = getCachedPreferences();
      hasSyncToken = Boolean(updatedPrefs.sync.token);
      syncLastAt = updatedPrefs.sync.lastSyncedAt;
      syncStatus = 'Sync started';
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

  async function handleObsidianImport(): Promise<void> {
    if (!isMobile || importing || !FolderImport) return;

    importing = true;
    importStatus = 'Picking folder...';

    try {
      const result = await FolderImport.pickAndReadMarkdownFiles();
      const files = result.files;

      if (!files || files.length === 0) {
        importStatus = 'No markdown files found';
        setTimeout(() => { importStatus = ''; importing = false; }, 2000);
        return;
      }

      importStatus = `Importing ${files.length} notes...`;

      // Detect duplicate names
      const nameCount = new Map<string, number>();
      for (const file of files) {
        const id = sanitizeFilename(file.name);
        nameCount.set(id, (nameCount.get(id) || 0) + 1);
      }

      let imported = 0;
      for (const file of files) {
        const baseName = sanitizeFilename(file.name);
        let id = baseName;
        // Disambiguate duplicates with folder path
        if ((nameCount.get(baseName) || 0) > 1 && file.path) {
          id = sanitizeFilename(`${file.name} (${file.path})`);
        }
        if (id) {
          const created = await createNote(id, file.content, file.lastModified);
          if (file.lastModified) {
            try {
              await FolderImport.setFileModificationTime({ filename: created.id + '.md', mtime: file.lastModified });
            } catch (_) { /* best-effort */ }
          }
          imported++;
        }
      }

      importStatus = `Imported ${imported} notes`;
      onimported(imported);
      setTimeout(() => { importStatus = ''; importing = false; }, 2000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('cancelled') || msg.includes('Cancelled')) {
        importStatus = '';
        importing = false;
      } else {
        importStatus = `Error: ${msg}`;
        setTimeout(() => { importStatus = ''; importing = false; }, 3000);
      }
    }
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
    try {
      await deleteAllNotes();
      onimported(0);
    } catch {
      nuking = false;
      nukeConfirm = false;
    }
  }

  function testCrash(): void {
    throw new Error('Test crash from Settings');
  }
</script>

<div class="settings-overlay" role="button" tabindex="-1" onclick={onclose} onkeydown={(e) => e.key === 'Escape' && onclose()}>
  <div class="settings-panel" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <div class="settings-header">
      <h2 class="settings-title">Settings</h2>
      <button class="settings-close" aria-label="Close settings" onclick={onclose}>&times;</button>
    </div>

    <div class="settings-content">
      {#if isElectron && notesDir}
      <section class="settings-section">
        <h3 class="settings-section-title">Storage</h3>
        <div class="settings-card">
          <p class="settings-btn-desc">{notesDir}</p>
        </div>
      </section>
      {/if}

      {#if hasFileSystem}
      <section class="settings-section">
        <h3 class="settings-section-title">Sync (MVP)</h3>
        <div class="settings-card">
          <label class="settings-input-label" for="sync-url">Server URL</label>
          <input
            id="sync-url"
            class="settings-input"
            type="text"
            bind:value={syncUrl}
            onblur={persistSyncUrl}
            placeholder="http://localhost:3100"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
          />
          <p class="settings-btn-desc settings-hint">
            Desktop/iOS simulator: <code>http://localhost:3100</code>. Android emulator: <code>http://10.0.2.2:3100</code>.
          </p>

          <label class="settings-input-label" for="sync-password">Password (for Connect)</label>
          <input
            id="sync-password"
            class="settings-input"
            type="password"
            bind:value={syncPassword}
            placeholder="At least 8 characters"
            autocapitalize="off"
            autocomplete="current-password"
            spellcheck="false"
          />

          <div class="settings-actions">
            <button class="settings-btn settings-btn-inline" onclick={handleConnectSync} disabled={syncBusy}>
              {syncBusy ? 'Working...' : hasSyncToken && syncUrl === tokenServerUrl ? 'Reconnect' : 'Connect'}
            </button>
            <button class="settings-btn settings-btn-inline" onclick={handleSyncNow} disabled={syncBusy}>
              Sync now
            </button>
          </div>

          <p class="settings-btn-desc settings-hint">Last sync: {formatTimestamp(syncLastAt)}</p>
          {#if syncStatus}
            <p class="settings-btn-desc settings-hint">{syncStatus}</p>
          {/if}
        </div>
      </section>
      {/if}

      {#if isMobile}
      <section class="settings-section">
        <h3 class="settings-section-title">Import</h3>
        <button class="settings-btn" onclick={handleObsidianImport} disabled={importing}>
          <span class="settings-btn-text">
            <span class="settings-btn-label">Import from Obsidian</span>
            <span class="settings-btn-desc">
              {#if importStatus}
                {importStatus}
              {:else}
                Select your vault folder to import all notes
              {/if}
            </span>
          </span>
          {#if !importing}
            <span class="settings-btn-arrow">&rsaquo;</span>
          {/if}
        </button>
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
                Delete all notes
              {/if}
            </span>
            <span class="settings-btn-desc">
              {#if nuking}
                Deleting...
              {:else if nukeConfirm}
                This cannot be undone!
              {:else}
                Permanently remove every note
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
    </div>
  </div>
</div>

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 200;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .settings-panel {
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
    background: var(--color-bg);
  }

  .settings-title {
    font-size: 20px;
    font-weight: 700;
    margin: 0;
    color: var(--color-text);
  }

  .settings-close {
    width: 36px;
    height: 36px;
    border: none;
    background: #292e42;
    border-radius: 50%;
    font-size: 22px;
    color: #a9b1d6;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
  }

  .settings-close:active {
    background: #343b58;
  }

  .settings-content {
    padding: 0 20px;
  }

  .settings-section {
    margin-bottom: 24px;
  }

  .settings-section-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-muted);
    margin: 0 0 8px 4px;
  }

  .settings-card {
    background: var(--color-surface);
    border-radius: 12px;
    padding: 14px;
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
    margin-bottom: 10px;
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
  }

  .settings-btn-inline {
    flex: 1;
    background: #292e42;
    color: #d8def8;
    justify-content: center;
    padding: 10px 12px;
  }

  .settings-btn:active {
    opacity: 0.7;
  }

  .settings-btn:disabled {
    cursor: default;
  }

  .settings-btn:disabled:active {
    opacity: 1;
  }

  .settings-btn-danger .settings-btn-label {
    color: #f7768e;
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

  .settings-btn-arrow {
    font-size: 22px;
    color: var(--color-muted);
    flex-shrink: 0;
    margin-left: 12px;
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
  }

  .settings-toggle-row:active {
    opacity: 0.7;
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
    background: #292e42;
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
    background: #565f89;
    position: absolute;
    top: 2px;
    left: 2px;
    transition: transform 0.2s ease;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }

  .settings-switch.on .settings-switch-thumb {
    transform: translateX(20px);
  }
</style>
