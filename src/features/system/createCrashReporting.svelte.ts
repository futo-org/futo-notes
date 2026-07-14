import { flushCrashQueue, setAppVersion, type CrashReport } from './crashHandler';
import {
  discardAllPendingReports,
  getLastSendError,
  loadPendingReports,
  sendAllPendingReports,
} from './crashReporter';
import { getCachedPreferences, savePreferences } from '$shared/state/appState';
import { getPlatformFS, hasFileSystem } from '$lib/platform';

interface CrashDialogResult {
  action: 'send' | 'discard';
  alwaysSend: boolean;
  userDescription?: string;
}

export function createCrashReporting(showToast: (message: string) => void) {
  let reports = $state<CrashReport[]>([]);
  let dialogOpen = $state(false);

  async function loadAppVersion(): Promise<void> {
    if (!hasFileSystem) {
      setAppVersion('0.0.0-web');
      return;
    }

    try {
      const platform = await getPlatformFS();
      setAppVersion(await platform.getAppVersion());
    } catch {
      setAppVersion('0.0.0-web');
    }
  }

  async function initialize(): Promise<void> {
    await loadAppVersion();
    await flushCrashQueue();

    if (import.meta.env.DEV) {
      await discardAllPendingReports().catch(() => undefined);
      return;
    }

    const preferences = getCachedPreferences();
    if (!preferences.crashReporting.enabled) return;

    const pendingReports = await loadPendingReports();
    if (pendingReports.length === 0) return;

    if (!preferences.crashReporting.alwaysSend) {
      reports = pendingReports;
      dialogOpen = true;
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }

    const result = await sendAllPendingReports();
    if (result.sent > 0) {
      showToast(`Sent ${result.sent} crash report${result.sent > 1 ? 's' : ''}`);
    } else if (result.failed > 0) {
      const reason = getLastSendError();
      showToast(
        reason ? `Auto-send failed: ${reason}` : 'Auto-send failed — reports saved locally',
      );
    }
  }

  async function resolve(result: CrashDialogResult): Promise<void> {
    dialogOpen = false;

    if (result.action === 'discard') {
      const preferences = getCachedPreferences();
      preferences.crashReporting.enabled = false;
      await savePreferences(preferences);
      await discardAllPendingReports();
      showToast('Crash reporting disabled. Re-enable in Settings.');
      reports = [];
      return;
    }

    if (result.alwaysSend) {
      const preferences = getCachedPreferences();
      preferences.crashReporting.alwaysSend = true;
      await savePreferences(preferences);
    }

    const sendResult = await sendAllPendingReports(result.userDescription);
    if (sendResult.sent > 0) {
      showToast(`Sent ${sendResult.sent} crash report${sendResult.sent > 1 ? 's' : ''}`);
    } else if (sendResult.failed > 0) {
      const reason = getLastSendError();
      showToast(reason ? `Failed to send: ${reason}` : 'Failed to send — reports saved locally');
    }
    reports = [];
  }

  return {
    get reports() {
      return reports;
    },
    get dialogOpen() {
      return dialogOpen;
    },
    initialize,
    resolve,
  };
}
