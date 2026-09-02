import { getAppState, getCachedPreferences } from '$shared/state/appState';
import { requestSyncV2, wasSyncErrorReported } from '$features/sync/autoSyncV2';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
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

export function createSyncSettings() {
  const appState = getAppState();
  const preferences = getCachedPreferences();
  const defaultUrl = import.meta.env.DEV && !appState.e2eeAuthToken ? 'http://127.0.0.1:3100' : '';
  let url = $state(appState.e2eeServerUrl || defaultUrl);
  let password = $state('');
  let busy = $state(false);
  const lastError = preferences.sync.lastError;
  let status = $state<LocalizedMessage | null>(
    lastError ? { path: 'sync.errors.previousFailure' } : null,
  );
  let lastSyncedAt = $state<number | null>(preferences.sync.lastSyncedAt);
  let connected = $state(Boolean(appState.e2eeAuthToken));
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
        await requestSyncV2();
      } finally {
        setSyncProgressListener(null);
      }
      password = '';
      lastSyncedAt = getCachedPreferences().sync.lastSyncedAt;
      connecting = false;
      status = null;
    } catch (error) {
      console.error('[e2ee] connect/sync failed:', error);
      connectError = connected
        ? { path: 'sync.errors.syncFailed' }
        : { path: 'sync.errors.connectFailed' };
      status = !connected
        ? { path: 'sync.errors.connectFailed' }
        : wasSyncErrorReported(error)
          ? null
          : { path: 'sync.errors.syncFailed' };
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
    await disconnectE2ee();
    passwordSaved = false;
  }

  async function forgetPassword(): Promise<void> {
    const confirmed = await confirmDialog(localizedText('sync.confirmations.forgetPasswordBody'), {
      title: localizedText('sync.confirmations.forgetPasswordTitle'),
      kind: 'warning',
    });
    if (!confirmed) return;

    await forgetStoredSyncPassword();
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
      await requestSyncV2();
      connected = Boolean(getAppState().e2eeAuthToken);
      lastSyncedAt = getCachedPreferences().sync.lastSyncedAt;
      status = null;
    } catch (error) {
      console.error('[e2ee] manual sync failed');
      status = wasSyncErrorReported(error) ? null : { path: 'sync.errors.syncFailed' };
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
