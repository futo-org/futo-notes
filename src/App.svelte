<script lang="ts">
  import NotesShell from './components/NotesShell.svelte';
  import TitleBar from './components/TitleBar.svelte';
  import CrashReportDialog from './components/CrashReportDialog.svelte';
  import { hasFileSystem, getFS, getPlatformFS, isDesktop, isLinux } from '$lib/platform';

  const showTitlebar = isDesktop && isLinux;
  if (showTitlebar) {
    document.documentElement.style.setProperty('--titlebar-height', '36px');
  }
  import { initNotes, createNote, getAllNotes, _injectTestNote } from '$lib/notes.svelte';
  import { loadPreferences, getCachedPreferences, savePreferences } from '$lib/appState';
  import { applyThemePreference, watchSystemThemeTauri } from '$lib/theme';
  import { flushCrashQueue, setAppVersion, type CrashReport } from '$lib/crashHandler';
  import { sendAllPendingReports, discardAllPendingReports, loadPendingReports } from '$lib/crashReporter';
  import { installTestSync } from '$lib/testSync';
  import { installTestInference } from '$lib/testInference';

  let hash = $state(window.location.hash.slice(1) || '/');
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

  const noteId = $derived.by(() => {
    if (hash === '/' || hash === '') return null;
    const match = hash.match(/^\/note\/(.+)$/);
    if (match) {
      const id = match[1];
      return id === 'new' ? 'new' : decodeURIComponent(id);
    }
    return null;
  });

  $effect(() => {
    function onHashChange(): void {
      hash = window.location.hash.slice(1) || '/';
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
              deleteAllContent: () => fs.deleteAllContent(),
              noteExists: (id: string) => fs.noteExists(id),
            };
            installTestSync();
            installTestInference();
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
        const version = await getFS().getAppVersion();
        setAppVersion(version);
      } else {
        setAppVersion('0.0.0-web');
      }
    } catch {
      setAppVersion('0.0.0-web');
    }

    // Flush any crashes queued in localStorage to files
    await flushCrashQueue();

    if (!prefs.crashReporting.enabled) return;

    // Load pending crash reports
    const reports = await loadPendingReports();
    if (reports.length === 0) return;

    if (prefs.crashReporting.alwaysSend) {
      // Auto-send without dialog
      const result = await sendAllPendingReports();
      if (result.sent > 0) {
        showToast(`Sent ${result.sent} crash report${result.sent > 1 ? 's' : ''}`);
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
        showToast('Failed to send — reports saved locally');
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
    <pre style="white-space: pre-wrap; background: #f0f0f0; padding: 10px; border-radius: 8px;">{error}</pre>
  </div>
{:else if initialized}
  {#if showTitlebar}
    <TitleBar />
  {/if}
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
