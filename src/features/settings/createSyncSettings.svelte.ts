import { getAppState, getCachedPreferences } from '$shared/state/appState';
import { requestSync, wasSyncErrorReported } from '$features/sync/autoSync';
import { isCertificateRejection } from '$features/sync/syncErrorClassification';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import {
  localizedText,
  resolveLocalizedMessage,
  type LocalizedMessage,
} from '$shared/localization';
import {
  connectE2ee,
  disconnectE2ee,
  forgetStoredSyncPassword,
  hasStoredSyncPassword,
  reauthenticateE2ee,
  setSyncProgressListener,
  type SyncProgress,
} from '$features/sync/syncServiceE2ee';

function syncProgressMessage(progress: SyncProgress): LocalizedMessage {
  const argumentsMap = { current: progress.current, total: progress.total };
  if (progress.phase === 'reconciling') {
    return { path: 'sync.progress.reconciling', arguments: argumentsMap };
  }
  if (progress.phase === 'pushing') {
    return { path: 'sync.progress.uploading', arguments: argumentsMap };
  }
  return { path: 'sync.progress.downloading', arguments: argumentsMap };
}

// Reset and forget are fired un-awaited from the UI and end in an app-state
// write, so a vault the app cannot write to (crash #1788) must not reject.
function reportSaveFailed(error: unknown): void {
  console.warn('[e2ee] could not save the sync change:', error);
  showGlobalToast({ path: 'settings.saveFailed' });
}

export function failureMessage(error: unknown, fallbackPath: string): LocalizedMessage {
  return isCertificateRejection(error)
    ? { path: 'sync.errors.certificateNotTrusted' }
    : { path: fallbackPath };
}

export function createSyncSettings() {
  const appState = getAppState();
  const preferences = getCachedPreferences();
  const defaultUrl = import.meta.env.DEV && !appState.e2eeServerUrl ? 'http://127.0.0.1:3100' : '';
  let url = $state(appState.e2eeServerUrl || defaultUrl);
  let password = $state('');
  let busy = $state(false);
  const lastError = preferences.sync.lastError;
  let status = $state<LocalizedMessage | null>(
    lastError ? { path: 'sync.errors.previousFailure' } : null,
  );
  let lastSyncedAt = $state<number | null>(preferences.sync.lastSyncedAt);
  let connected = $state(Boolean(appState.e2eeServerUrl && appState.e2eeCollectionId));
  let passwordSaved = $state(hasStoredSyncPassword());
  let connecting = $state(false);
  let connectPhase = $state<LocalizedMessage | null>(null);
  let connectError = $state<LocalizedMessage | null>(null);
  async function connect(): Promise<void> {
    if (busy) return;
    busy = true;
    connecting = true;
    connectPhase = { path: 'sync.progress.connectingToServer' };
    connectError = null;
    try {
      await connectE2ee(url, password);
      connected = true;
      passwordSaved = hasStoredSyncPassword();
      connectPhase = { path: 'sync.progress.syncingNotes' };
      setSyncProgressListener((progress) => (connectPhase = syncProgressMessage(progress)));
      try {
        await requestSync();
      } finally {
        setSyncProgressListener(null);
      }
      password = '';
      lastSyncedAt = getCachedPreferences().sync.lastSyncedAt;
      connecting = false;
      status = null;
    } catch (error) {
      console.error('[e2ee] connect/sync failed:', error);
      connectError = failureMessage(
        error,
        connected ? 'sync.errors.syncFailed' : 'sync.errors.connectFailed',
      );
      status = !connected
        ? failureMessage(error, 'sync.errors.connectFailed')
        : wasSyncErrorReported(error)
          ? null
          : failureMessage(error, 'sync.errors.syncFailed');
    } finally {
      busy = false;
    }
  }
  function cancelConnect(): void {
    connecting = false;
    connectError = null;
  }
  async function resetConnection(): Promise<void> {
    const confirmed = await confirmDialog(localizedText('sync.confirmations.resetConnectionBody'), {
      title: localizedText('sync.confirmations.resetConnectionTitle'),
      kind: 'warning',
    });
    if (!confirmed) return;
    connected = false;
    password = '';
    status = null;
    await disconnectE2ee().catch(reportSaveFailed);
    passwordSaved = false;
  }

  async function forgetPassword(): Promise<void> {
    const confirmed = await confirmDialog(localizedText('sync.confirmations.forgetPasswordBody'), {
      title: localizedText('sync.confirmations.forgetPasswordTitle'),
      kind: 'warning',
    });
    if (!confirmed) return;

    await forgetStoredSyncPassword().catch(reportSaveFailed);
    passwordSaved = false;
  }

  function handleUrlClick(): void {
    if (connected) void resetConnection();
  }

  async function syncNow(): Promise<void> {
    if (busy) return;
    busy = true;
    status = { path: 'sync.status.syncing' };
    try {
      if (password) {
        await reauthenticateE2ee(password);
        password = '';
        passwordSaved = hasStoredSyncPassword();
        connected = true;
      }
      await requestSync();
      connected = Boolean(getAppState().e2eeServerUrl && getAppState().e2eeCollectionId);
      lastSyncedAt = getCachedPreferences().sync.lastSyncedAt;
      status = null;
    } catch (error) {
      console.error('[e2ee] manual sync failed');
      status = wasSyncErrorReported(error) ? null : failureMessage(error, 'sync.errors.syncFailed');
    } finally {
      busy = false;
    }
  }

  return {
    get url() {
      return url;
    },
    set url(value: string) {
      url = value;
    },
    get password() {
      return password;
    },
    set password(value: string) {
      password = value;
    },
    get busy() {
      return busy;
    },
    get status() {
      return status ? resolveLocalizedMessage(status) : '';
    },
    get lastSyncedAt() {
      return lastSyncedAt;
    },
    get connected() {
      return connected;
    },
    get passwordSaved() {
      return passwordSaved;
    },
    get connecting() {
      return connecting;
    },
    get connectPhase() {
      return connectPhase ? resolveLocalizedMessage(connectPhase) : '';
    },
    get connectError() {
      return connectError ? resolveLocalizedMessage(connectError) : '';
    },
    connect,
    cancelConnect,
    resetConnection,
    forgetPassword,
    handleUrlClick,
    syncNow,
  };
}

export type SyncSettings = ReturnType<typeof createSyncSettings>;
