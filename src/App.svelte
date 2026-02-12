<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { StatusBar, Style } from '@capacitor/status-bar';
  import NotesShell from './components/NotesShell.svelte';
  import CrashReportDialog from './components/CrashReportDialog.svelte';
  import { initNotes } from '$lib/notes';
  import { loadPreferences, getCachedPreferences, savePreferences } from '$lib/preferences';
  import { flushCrashQueue, setAppVersion, type CrashReport } from '$lib/crashHandler';
  import { checkHeartbeat, startHeartbeat } from '$lib/heartbeat';
  import { sendAllPendingReports, discardAllPendingReports, loadPendingReports } from '$lib/crashReporter';

  let hash = $state(window.location.hash.slice(1) || '/');
  let initialized = $state(false);
  let error: string | null = $state(null);

  let pendingCrashReports: CrashReport[] = $state([]);
  let showCrashDialog = $state(false);
  let toastMessage = $state('');
  let toastTimer: number | null = null;

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

    async function init(): Promise<void> {
      try {
        if (Capacitor.isNativePlatform()) {
          await initNotes();
          try {
            await StatusBar.setOverlaysWebView({ overlay: true });
            await StatusBar.setStyle({ style: Style.Light });
            await StatusBar.setBackgroundColor({ color: '#00000000' });
          } catch {
            // Some status bar APIs are unavailable on newer Android versions.
          }
        }
        initialized = true;

        // Crash reporting init (runs after notes init so filesystem is ready)
        try {
          await initCrashReporting();
        } catch (e) {
          console.warn('Crash reporting init failed:', e);
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    init();

    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  });

  async function initCrashReporting(): Promise<void> {
    const prefs = await loadPreferences();

    // Set app version from Capacitor App plugin
    try {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      setAppVersion(info.version);
    } catch {
      setAppVersion('0.0.0-web');
    }

    // Flush any crashes queued in localStorage to files
    await flushCrashQueue();

    // Check for unclean shutdown (native crash detection)
    await checkHeartbeat();

    // Start heartbeat for this session
    startHeartbeat();

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
      // Show dialog
      pendingCrashReports = reports;
      showCrashDialog = true;
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
      } else if (sendResult.failed > 0) {
        showToast('Failed to send crash reports');
      }
    } else {
      // User chose "Don't Send" - disable crash reporting entirely
      await discardAllPendingReports();
      const prefs = getCachedPreferences();
      prefs.crashReporting.enabled = false;
      prefs.crashReporting.alwaysSend = false;
      await savePreferences(prefs);
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
  <NotesShell {noteId} />
{:else}
  <!-- Loading -->
{/if}

{#if showCrashDialog}
  <CrashReportDialog reports={pendingCrashReports} onresolved={handleCrashDialogResolved} />
{/if}

{#if toastMessage}
  <div class="toast">{toastMessage}</div>
{/if}
