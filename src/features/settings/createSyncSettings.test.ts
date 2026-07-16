// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const appStateMock = {
  e2eeServerUrl: '',
  e2eeAuthToken: '',
};
const preferencesMock = {
  sync: { lastError: '', lastSyncedAt: null as number | null },
};
vi.mock('$shared/state/appState', () => ({
  getAppState: vi.fn(() => appStateMock),
  getCachedPreferences: vi.fn(() => preferencesMock),
}));

const requestSyncV2 = vi.fn();
const wasSyncErrorReported = vi.fn(() => false);
vi.mock('$features/sync/autoSyncV2', () => ({
  requestSyncV2: (...args: unknown[]) => requestSyncV2(...args),
  wasSyncErrorReported: (...args: unknown[]) => wasSyncErrorReported(...args),
}));

const confirmDialog = vi.fn();
vi.mock('$shared/dialogs/confirmDialog', () => ({
  confirmDialog: (...args: unknown[]) => confirmDialog(...args),
}));

const connectE2ee = vi.fn();
const disconnectE2ee = vi.fn();
const forgetStoredSyncPassword = vi.fn();
const reauthenticateE2ee = vi.fn();
const hasStoredSyncPassword = vi.fn(() => false);
type ProgressListener = ((p: { phase: string; current: number; total: number }) => void) | null;
let progressListener: ProgressListener = null;
vi.mock('$features/sync/syncServiceE2ee', () => ({
  connectE2ee: (...args: unknown[]) => connectE2ee(...args),
  disconnectE2ee: (...args: unknown[]) => disconnectE2ee(...args),
  forgetStoredSyncPassword: (...args: unknown[]) => forgetStoredSyncPassword(...args),
  reauthenticateE2ee: (...args: unknown[]) => reauthenticateE2ee(...args),
  hasStoredSyncPassword: () => hasStoredSyncPassword(),
  setSyncProgressListener: (listener: ProgressListener) => {
    progressListener = listener;
  },
}));

import { createSyncSettings } from './createSyncSettings.svelte';

beforeEach(() => {
  appStateMock.e2eeServerUrl = '';
  appStateMock.e2eeAuthToken = '';
  preferencesMock.sync = { lastError: '', lastSyncedAt: null };
  requestSyncV2.mockReset().mockResolvedValue({});
  wasSyncErrorReported.mockReset().mockReturnValue(false);
  confirmDialog.mockReset();
  connectE2ee.mockReset().mockResolvedValue(undefined);
  disconnectE2ee.mockReset().mockResolvedValue(undefined);
  forgetStoredSyncPassword.mockReset().mockResolvedValue(undefined);
  reauthenticateE2ee.mockReset().mockResolvedValue(undefined);
  hasStoredSyncPassword.mockReset().mockReturnValue(false);
  progressListener = null;
});

describe('createSyncSettings', () => {
  it('connect runs a first sync, clears the password field, and reports connected', async () => {
    const sync = createSyncSettings();
    sync.url = 'http://server:3100';
    sync.password = 'hunter2';

    await sync.connect();

    expect(connectE2ee).toHaveBeenCalledWith('http://server:3100', 'hunter2');
    expect(requestSyncV2).toHaveBeenCalledTimes(1);
    expect(sync.connected).toBe(true);
    expect(sync.password).toBe('');
    expect(sync.busy).toBe(false);
    expect(sync.connecting).toBe(false);
  });

  it('renders the granular phase readout (Reconciling/Uploading/Downloading current/total)', async () => {
    let finishSync!: () => void;
    requestSyncV2.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
    );
    const sync = createSyncSettings();
    sync.url = 'http://server:3100';
    sync.password = 'pw';

    const pending = sync.connect();
    await vi.waitFor(() => {
      if (!progressListener) throw new Error('listener not installed yet');
    });

    progressListener!({ phase: 'reconciling', current: 1, total: 4 });
    expect(sync.connectPhase).toBe('Reconciling 1/4…');
    progressListener!({ phase: 'pushing', current: 3, total: 9 });
    expect(sync.connectPhase).toBe('Uploading 3/9…');
    progressListener!({ phase: 'pulling', current: 2, total: 5 });
    expect(sync.connectPhase).toBe('Downloading 2/5…');

    finishSync();
    await pending;
    // The listener is uninstalled once the first sync settles.
    expect(progressListener).toBeNull();
  });

  it('reports a failed connect inline as "Connect failed: …"', async () => {
    connectE2ee.mockRejectedValue(new Error('bad password'));
    const sync = createSyncSettings();
    sync.url = 'http://server:3100';
    sync.password = 'wrong';

    await sync.connect();

    expect(sync.connected).toBe(false);
    expect(sync.status).toBe('Connect failed: bad password');
  });

  it('stays quiet when the sync manager already reported the failure (single-reporter contract)', async () => {
    requestSyncV2.mockRejectedValue(new Error('cycle failed'));
    wasSyncErrorReported.mockReturnValue(true);
    const sync = createSyncSettings();
    sync.url = 'http://server:3100';
    sync.password = 'pw';

    await sync.connect();

    expect(sync.status).toBe('');
  });

  it('reset connection is gated on the confirm dialog', async () => {
    appStateMock.e2eeAuthToken = 'token';
    const sync = createSyncSettings();

    confirmDialog.mockResolvedValue(false);
    await sync.resetConnection();
    expect(disconnectE2ee).not.toHaveBeenCalled();
    expect(sync.connected).toBe(true);

    confirmDialog.mockResolvedValue(true);
    await sync.resetConnection();
    expect(disconnectE2ee).toHaveBeenCalledTimes(1);
    expect(sync.connected).toBe(false);
    expect(sync.passwordSaved).toBe(false);
  });

  it('clicking the locked server URL opens the reset-connection confirm (hidden affordance)', async () => {
    appStateMock.e2eeAuthToken = 'token';
    confirmDialog.mockResolvedValue(false);
    const sync = createSyncSettings();

    sync.handleUrlClick();
    await vi.waitFor(() => {
      expect(confirmDialog).toHaveBeenCalledWith(
        'Are you sure you want to reset the connection?',
        expect.objectContaining({ title: 'Reset connection' }),
      );
    });
  });

  it('forget password drops only the stored keyring entry after confirmation', async () => {
    appStateMock.e2eeAuthToken = 'token';
    hasStoredSyncPassword.mockReturnValue(true);
    confirmDialog.mockResolvedValue(true);
    const sync = createSyncSettings();
    expect(sync.passwordSaved).toBe(true);

    await sync.forgetPassword();

    expect(forgetStoredSyncPassword).toHaveBeenCalledTimes(1);
    expect(disconnectE2ee).not.toHaveBeenCalled();
    expect(sync.passwordSaved).toBe(false);
    expect(sync.connected).toBe(true);
  });

  it('seeds status from the persisted last sync error', () => {
    preferencesMock.sync.lastError = 'server exploded';
    const sync = createSyncSettings();
    expect(sync.status).toBe('Last error: server exploded');
  });

  it('syncNow updates lastSyncedAt and clears status on success', async () => {
    preferencesMock.sync.lastSyncedAt = 1234;
    appStateMock.e2eeAuthToken = 'token';
    const sync = createSyncSettings();

    await sync.syncNow();

    expect(requestSyncV2).toHaveBeenCalledTimes(1);
    expect(sync.lastSyncedAt).toBe(1234);
    expect(sync.status).toBe('');
  });

  it('reauthenticates with an entered password before syncing and clears it only after', async () => {
    appStateMock.e2eeServerUrl = 'https://notes.example.com';
    appStateMock.e2eeAuthToken = 'expired-token';
    hasStoredSyncPassword.mockReturnValue(true);
    const sync = createSyncSettings();
    sync.password = 'saved-password';

    await sync.syncNow();

    expect(reauthenticateE2ee).toHaveBeenCalledWith('saved-password');
    expect(reauthenticateE2ee.mock.invocationCallOrder[0]).toBeLessThan(
      requestSyncV2.mock.invocationCallOrder[0],
    );
    expect(sync.password).toBe('');
    expect(sync.passwordSaved).toBe(true);
    expect(sync.connected).toBe(true);
  });
});
