import { flushCrashQueue, setAppVersion, type CrashReport } from './crashHandler';
import {
  discardAllPendingReports,
  getLastSendError,
  loadPendingReports,
  sendAllPendingReports,
} from './crashReporter';
import { getCachedPreferences, savePreferences } from '$shared/state/appState';
import { getPlatformFS, hasFileSystem } from '$lib/platform';
import type { ToastMessage } from '$shared/notifications/toastBus.svelte';

interface CrashDialogResult {
  action: 'send' | 'discard';
  alwaysSend: boolean;
  userDescription?: string;
}

export function createCrashReporting(showToast: (message: ToastMessage) => void) {
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
      showToast({ path: 'crashReporting.sentCount', arguments: { count: result.sent } });
    } else if (result.failed > 0) {
      console.warn('Automatic crash report send failed:', getLastSendError());
      showToast({ path: 'crashReporting.sendFailed' });
    }
  }

  async function resolve(result: CrashDialogResult): Promise<void> {
    dialogOpen = false;

    if (result.action === 'discard') {
      const preferences = getCachedPreferences();
      preferences.crashReporting.enabled = false;
      await savePreferences(preferences);
      await discardAllPendingReports();
      showToast({ path: 'crashReporting.disabled' });
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
      showToast({ path: 'crashReporting.sentCount', arguments: { count: sendResult.sent } });
    } else if (sendResult.failed > 0) {
      console.warn('Crash report send failed:', getLastSendError());
      showToast({ path: 'crashReporting.sendFailed' });
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
