import { getAppState, getCachedPreferences } from '$shared/state/appState';
import { requestSyncV2, wasSyncErrorReported } from '$features/sync/autoSyncV2';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { getSyncErrorMessage } from '$features/sync/syncErrorMessage';
import {
  connectE2ee,
  disconnectE2ee,
  forgetStoredSyncPassword,
  hasStoredSyncPassword,
  setSyncProgressListener,
} from '$features/sync/syncServiceE2ee';

export function createSyncSettings() {
  const appState = getAppState();
  const preferences = getCachedPreferences();
  let url = $state(
    appState.e2eeServerUrl ||
      (import.meta.env.DEV && !appState.e2eeAuthToken ? 'http://127.0.0.1:3100' : ''),
  );
  let password = $state('');
  let busy = $state(false);
  let status = $state(
    preferences.sync.lastError ? `Last error: ${preferences.sync.lastError}` : '',
  );
  let lastSyncedAt = $state<number | null>(preferences.sync.lastSyncedAt);
  let connected = $state(Boolean(appState.e2eeAuthToken));
  let passwordSaved = $state(hasStoredSyncPassword());
  let connecting = $state(false);
  let connectPhase = $state('');
  let connectError = $state('');

  async function connect(): Promise<void> {
    if (busy) return;
    busy = true;
    connecting = true;
    connectPhase = 'Connecting to server...';
    connectError = '';

    try {
      await connectE2ee(url, password);
      connected = true;
      passwordSaved = hasStoredSyncPassword();
      connectPhase = 'Syncing notes...';
      setSyncProgressListener((progress) => {
        const label =
          progress.phase === 'reconciling'
            ? 'Reconciling'
            : progress.phase === 'pushing'
              ? 'Uploading'
              : 'Downloading';
        connectPhase = `${label} ${progress.current}/${progress.total}…`;
      });
      try {
        await requestSyncV2();
      } finally {
        setSyncProgressListener(null);
      }
      password = '';
      lastSyncedAt = getCachedPreferences().sync.lastSyncedAt;
      connecting = false;
      status = '';
    } catch (error) {
      console.error('[e2ee] connect/sync failed:', error);
      connectError = getSyncErrorMessage(error);
      if (!connected) {
        status = `Connect failed: ${connectError}`;
      } else if (wasSyncErrorReported(error)) {
        status = '';
      } else {
        status = `Sync failed: ${connectError}`;
      }
    } finally {
      busy = false;
    }
  }

  function cancelConnect(): void {
    connecting = false;
    connectError = '';
  }

  async function resetConnection(): Promise<void> {
    const confirmed = await confirmDialog('Are you sure you want to reset the connection?', {
      title: 'Reset connection',
      kind: 'warning',
    });
    if (!confirmed) return;

    connected = false;
    password = '';
    status = '';
    await disconnectE2ee();
    passwordSaved = false;
  }

  async function forgetPassword(): Promise<void> {
    const confirmed = await confirmDialog(
      'Forget the saved sync password? You will be asked to re-enter it to sync after the next restart.',
      { title: 'Forget password', kind: 'warning' },
    );
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
    status = 'Syncing...';
    try {
      password = '';
      await requestSyncV2();
      connected = Boolean(getAppState().e2eeAuthToken);
      lastSyncedAt = getCachedPreferences().sync.lastSyncedAt;
      status = '';
    } catch (error) {
      status = wasSyncErrorReported(error) ? '' : `Sync failed: ${getSyncErrorMessage(error)}`;
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
      return status;
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
      return connectPhase;
    },
    get connectError() {
      return connectError;
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
