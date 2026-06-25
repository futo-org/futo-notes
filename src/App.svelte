<script lang="ts">
  import NotesShell from './components/NotesShell.svelte';
  import TitleBar from './components/TitleBar.svelte';
  import CrashReportDialog from './components/CrashReportDialog.svelte';
  import { hasFileSystem, getFS, getPlatformFS, isDesktop, isLinux, isMac } from '$lib/platform';
  import { installExternalFileDropGuard } from '$lib/externalFileDropGuard';
  import { tabsStore } from '$lib/tabsStore.svelte';
  import { noteIdFromHash } from './router';

  const showTitlebar = isDesktop && isLinux;
  if (showTitlebar) {
    document.documentElement.style.setProperty('--titlebar-height', '36px');
  }
  // macOS uses the system traffic lights over a transparent titlebar
  // (configured in tauri.conf.json via "titleBarStyle": "Overlay" with
  // `trafficLightPosition: { x: 19, y: 20 }` and `hiddenTitle: true` so the
  // native window-title text doesn't draw over our tab strip). The lights
  // live centered in a top band — Obsidian-style top-of-window tab bar.
  //
  // `--tabs-strip-height` is that band's height. It's sized so the lights
  // (top at y=20, ~12px tall) sit with comfortable margin above and below:
  // 48px → ~20px above the lights, ~16px below. On non-mac platforms the
  // strip falls back to its default 40px (no lights to clear).
  //
  // `--macos-titlebar-inset` pushes the sidebar header's content below
  // where the traffic lights sit so they don't overlap; matched to the
  // strip height (16px base padding + 32px inset = 48px) so the expanded
  // sidebar header and the collapsed tab strip share one top band.
  //
  // `--macos-traffic-lights-width` is the leading clearance the tabs
  // strip / sidebar-expand-button need when the sidebar is COLLAPSED:
  // there's no sidebar to host the lights so they overlap the strip's
  // left edge directly. Three buttons starting at x≈19 with ~20px
  // spacing land the rightmost light at ~x=71; 96px gives a clear gap.
  if (isDesktop && isMac) {
    document.documentElement.style.setProperty('--macos-titlebar-inset', '32px');
    document.documentElement.style.setProperty('--macos-traffic-lights-width', '96px');
    document.documentElement.style.setProperty('--tabs-strip-height', '48px');
  } else {
    document.documentElement.style.setProperty('--macos-titlebar-inset', '0px');
    document.documentElement.style.setProperty('--macos-traffic-lights-width', '0px');
  }
  import { initNotes, createNote, getAllNotes, _injectTestNote, deleteNote as deleteNoteApp, moveNote as moveNoteWithCollisionHandling } from '$lib/notes.svelte';
  import { loadPreferences, getCachedPreferences, savePreferences } from '$lib/appState';
  import { applyThemePreference, watchSystemThemeTauri } from '$lib/theme';
  import { flushCrashQueue, setAppVersion, type CrashReport } from '$lib/crashHandler';
  import { sendAllPendingReports, discardAllPendingReports, loadPendingReports, getLastSendError } from '$lib/crashReporter';
  import { installTestSync } from '$lib/testSync';
  import { searchNotes, isSearchIndexPopulated } from '$lib/searchIndex';

  // Synchronous listener install — keeps OS file drops from navigating the
  // webview away from the app (required on Windows where dragDropEnabled is
  // off; see tauri.windows.conf.json and externalFileDropGuard.ts).
  installExternalFileDropGuard();

  let initialized = $state(false);
  let error: string | null = $state(null);
  // Visible step-by-step trace for diagnosing init hangs on real devices
  // where attaching Web Inspector is impractical. Surfaced in the loading
  // screen overlay until `initialized = true`.
  let initStep = $state('booting');

  let pendingCrashReports: CrashReport[] = $state([]);
  let showCrashDialog = $state(false);
  let toastMessage = $state('');
  let toastTimer: number | null = null;
  let stopWatchingSystemTheme: (() => void) | null = null;

  function showToast(message: string): void {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastMessage = message;
    toastTimer = window.setTimeout(() => { toastMessage = ''; toastTimer = null; }, 3000);
  }

  // The initial URL hash is applied to the store inside `tabsStore.hydrate()`
  // (called from NotesShell once persisted tabs have loaded). Mutating the
  // store synchronously here would mark it non-pristine and silently drop
  // the persisted snapshot on every deep-linked reload.

  const noteId = $derived(tabsStore.activeNoteId);

  // Mirror active tab → URL hash. Uses replaceState so we don't refire
  // the hashchange listener (which would loop back into openNote).
  // Gated on `hydrated`: pre-hydrate, the URL still carries the boot
  // target we need hydrate() to read, so we mustn't overwrite it.
  $effect(() => {
    if (!tabsStore.hydrated) return;
    const id = tabsStore.activeNoteId;
    const target = id === null ? '#/' : `#/note/${encodeURIComponent(id)}`;
    if (window.location.hash !== target) {
      history.replaceState(history.state, '', target);
    }
  });

  $effect(() => {
    function onHashChange(): void {
      const parsed = noteIdFromHash(window.location.hash);
      if (parsed !== tabsStore.activeNoteId) {
        tabsStore.openNote(parsed, 'current');
      }
    }
    window.addEventListener('hashchange', onHashChange);

    let currentLabel = '';
    let labelStartedAt = 0;
    function setStep(label: string): void {
      currentLabel = label;
      labelStartedAt = Date.now();
      initStep = label;
    }
    const watchdog = window.setInterval(() => {
      if (!currentLabel) return;
      const elapsed = ((Date.now() - labelStartedAt) / 1000).toFixed(1);
      initStep = `${currentLabel} (${elapsed}s)`;
    }, 500);
    async function trace<T>(label: string, p: Promise<T>): Promise<T> {
      setStep(label);
      try {
        return await p;
      } finally {
        if (currentLabel === label) currentLabel = '';
      }
    }

    async function init(): Promise<void> {
      // CRITICAL: render the shell synchronously. Anything else — even
      // a dynamic import for the platform FS module — runs in the
      // background. Past hangs accumulated whenever something was
      // awaited before `initialized = true`: bootstrapSearchIndex,
      // scanNotePreviewsWithBodies, loadPreferences, getPlatformFS.
      initialized = true;
      clearInterval(watchdog);

      void getPlatformFS().catch((e) => console.warn('getPlatformFS failed:', e));

      // ── Background work — none of these block the UI ─────────────
      void (async () => {
        try {
          const prefs = await loadPreferences();
          await applyThemePreference(prefs.appearance.theme);
          stopWatchingSystemTheme?.();
          stopWatchingSystemTheme = watchSystemThemeTauri((tauriTheme) => {
            const latestPrefs = getCachedPreferences();
            if (latestPrefs.appearance.theme === 'auto') {
              void applyThemePreference('auto', tauriTheme);
            }
          });
        } catch (e) {
          console.warn('Theme/prefs init failed:', e);
        }
      })();

      if (hasFileSystem || import.meta.env.DEV) {
        initNotes((label) => { initStep = label; }).then(() => {
          if (import.meta.env.DEV || import.meta.env.VITE_INCLUDE_TEST_HOOKS === 'true') {
            const fs = getFS();
            (window as any).__testNotes = {
              createNote,
              getAllNotes,
              _injectTestNote,
              listNoteFiles: () => fs.listNoteFiles(),
              readNote: (id: string) => fs.readNote(id),
              writeNote: (id: string, content: string, modifiedAtMs?: number) => fs.writeNote(id, content, modifiedAtMs),
              deleteNoteFile: (id: string) => fs.deleteNoteFile(id),
              // App-level delete: prunes notesCache synchronously like a real
              // user delete. deleteNoteFile above stays raw-FS for scenarios
              // that simulate external deletions.
              deleteNote: (id: string) => deleteNoteApp(id),
              deleteAllContent: () => fs.deleteAllContent(),
              noteExists: (id: string) => fs.noteExists(id),
              // Folder ops — exposed for cross-platform sync tests covering
              // the conflict-resolution table in the folder-support spec.
              listFolders: () => fs.listFolders?.(),
              createFolder: (path: string) => fs.createFolder?.(path),
              renameFolder: (from: string, to: string) => fs.renameFolder?.(from, to),
              deleteFolder: (path: string) => fs.deleteFolder?.(path),
              moveNote: (fromId: string, toId: string) => fs.moveNote?.(fromId, toId),
              // High-level move that suffixes the incoming file when the
              // destination already exists (Spec § 4 sync conflict row).
              moveNoteWithCollisions: (fromId: string, toId: string) =>
                moveNoteWithCollisionHandling(fromId, toId),
            };
            installTestSync();
            (window as any).__testSearch = {
              search: (query: string) => searchNotes(query),
              isPopulated: () => isSearchIndexPopulated(),
            };
          }
        }).catch((e) => {
          console.warn('initNotes failed:', e);
        });
      }

      void (async () => {
        try {
          await initCrashReporting();
        } catch (e) {
          console.warn('Crash reporting init failed:', e);
        }
      })();
    }
    init();

    return () => {
      window.removeEventListener('hashchange', onHashChange);
      stopWatchingSystemTheme?.();
      stopWatchingSystemTheme = null;
    };
  });

  async function initCrashReporting(): Promise<void> {
    const prefs = getCachedPreferences();

    // Set app version from platform
    try {
      if (hasFileSystem) {
        // Must await getPlatformFS() — getFS() throws if the dynamic
        // import hasn't resolved yet, and this IIFE races the one in
        // init() that kicked off the FS load.
        const fs = await getPlatformFS();
        const version = await fs.getAppVersion();
        setAppVersion(version);
      } else {
        setAppVersion('0.0.0-web');
      }
    } catch {
      setAppVersion('0.0.0-web');
    }

    // Flush any crashes queued in localStorage to files
    await flushCrashQueue();

    // In dev mode, the crash dialog is mostly noise — force-quits, MCP
    // kills, and frequent rebuilds produce spurious reports that get in
    // the way. Discard anything pending and skip the dialog/auto-send.
    if (import.meta.env.DEV) {
      await discardAllPendingReports().catch(() => {});
      return;
    }

    if (!prefs.crashReporting.enabled) return;

    // Load pending crash reports
    const reports = await loadPendingReports();
    if (reports.length === 0) return;

    if (prefs.crashReporting.alwaysSend) {
      // Auto-send without dialog
      const result = await sendAllPendingReports();
      if (result.sent > 0) {
        showToast(`Sent ${result.sent} crash report${result.sent > 1 ? 's' : ''}`);
      } else if (result.failed > 0) {
        const reason = getLastSendError();
        showToast(reason
          ? `Auto-send failed: ${reason}`
          : 'Auto-send failed — reports saved locally');
      }
    } else {
      // Show dialog — dismiss keyboard so toolbar hides
      pendingCrashReports = reports;
      showCrashDialog = true;
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  async function handleCrashDialogResolved(result: { action: 'send' | 'discard'; alwaysSend: boolean; userDescription?: string }): Promise<void> {
    showCrashDialog = false;

    if (result.action === 'send') {
      if (result.alwaysSend) {
        const prefs = getCachedPreferences();
        prefs.crashReporting.alwaysSend = true;
        await savePreferences(prefs);
      }

      const sendResult = await sendAllPendingReports(result.userDescription);
      if (sendResult.sent > 0) {
        showToast(`Sent ${sendResult.sent} crash report${sendResult.sent > 1 ? 's' : ''}`);
      } else if (sendResult.failed > 0 && sendResult.sent === 0) {
        const reason = getLastSendError();
        showToast(reason
          ? `Failed to send: ${reason}`
          : 'Failed to send — reports saved locally');
      }
    } else {
      // User chose "Don't Send" — permanent opt-out
      const prefs = getCachedPreferences();
      prefs.crashReporting.enabled = false;
      await savePreferences(prefs);
      await discardAllPendingReports();
      showToast('Crash reporting disabled. Re-enable in Settings.');
    }

    pendingCrashReports = [];
  }
</script>

{#if error}
  <div style="padding: 20px; font-family: system-ui;">
    <h1>Init Error</h1>
    <pre style="white-space: pre-wrap; background: #fcfcfc; padding: 10px; border-radius: 8px;">{error}</pre>
  </div>
{:else if initialized}
  {#if showTitlebar}
    <TitleBar />
  {/if}
  <!-- macOS window drag is provided by the tabs strip itself
       (data-tauri-drag-region on the strip background). Traffic lights
       are positioned by Tauri via `trafficLightPosition` in
       tauri.conf.json so they vertically center inside the strip. -->
  <NotesShell {noteId} />
{:else}
  <div class="loading-screen">
    <div class="loading-spinner"></div>
    <div class="loading-step">{initStep}</div>
  </div>
{/if}

{#if showCrashDialog}
  <CrashReportDialog reports={pendingCrashReports} onresolved={handleCrashDialogResolved} />
{/if}

{#if toastMessage}
  <div class="toast">{toastMessage}</div>
{/if}

<style>
  .loading-screen {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: var(--color-bg);
  }

  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2.5px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: loading-spin 0.8s linear infinite;
  }

  .loading-step {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--color-muted, #888);
    text-align: center;
    padding: 0 16px;
    max-width: 90vw;
    word-break: break-word;
  }

  @keyframes loading-spin {
    to { transform: rotate(360deg); }
  }

</style>
