import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const appStateMock = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve({ token: 't', userId: 'u', collectionId: 'c' })),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('$shared/state/appState', () => ({
  clearLegacyE2eePassword: vi.fn(),
  commitLegacySyncStateScrub: vi.fn(() => Promise.resolve(true)),
  getAppState: vi.fn(() => appStateMock.state),
  getLegacyE2eePassword: vi.fn(() => undefined),
  getLegacySyncState: vi.fn(() => undefined),
  loadAppState: vi.fn(() => Promise.resolve()),
  saveAppState: vi.fn((state: Record<string, unknown>) => {
    appStateMock.state = state;
    return Promise.resolve();
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import { getAppState, saveAppState } from '$shared/state/appState';
import {
  validateSyncServerUrl,
  connectE2ee,
  isRecoverableSessionError,
  reauthenticateE2ee,
  syncE2eeAuto,
} from './syncServiceE2ee';

const mockInvoke = vi.mocked(invoke);
const mockSaveAppState = vi.mocked(saveAppState);

const serverUrlFixture = JSON.parse(
  readFileSync(new URL('../../../tests/conformance/server-url.json', import.meta.url), 'utf8'),
) as { op: string; cases: { input: string; expected: string | null }[] };

describe('validateSyncServerUrl — conformance fixture (tests/conformance/server-url.json)', () => {
  for (const c of serverUrlFixture.cases) {
    const verb = c.expected === null ? 'accepts' : 'rejects';
    it(`${verb} ${JSON.stringify(c.input)}`, () => {
      expect(validateSyncServerUrl(c.input)).toBe(c.expected);
    });
  }
});

describe('connectE2ee normalizes the server URL (sync.md)', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ token: 't', userId: 'u', collectionId: 'c' });
    appStateMock.state = {};
    mockSaveAppState.mockClear();
  });

  it('trims surrounding whitespace before connecting AND persisting', async () => {
    await connectE2ee('  https://notes.example.com  ', 'pw');

    const connectArgs = mockInvoke.mock.calls.find((c) => c[0] === 'e2ee_connect');
    expect(connectArgs).toBeDefined();
    expect((connectArgs![1] as { input: { serverUrl: string } }).input.serverUrl).toBe(
      'https://notes.example.com',
    );

    const savedState = mockSaveAppState.mock.calls.at(-1)![0] as { e2eeServerUrl: string };
    expect(savedState.e2eeServerUrl).toBe('https://notes.example.com');
  });

  it('rejects a schemeless URL before invoking the connect command', async () => {
    await expect(connectE2ee('notes.example.com', 'pw')).rejects.toThrow(
      /Add http:\/\/ or https:\/\//,
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('expired-session recovery', () => {
  const configured = {
    e2eeServerUrl: 'https://notes.example.com',
    e2eeAuthToken: 'expired-token',
    e2eeUserId: 'user-1',
    e2eeCollectionId: 'collection-1',
  } as ReturnType<typeof getAppState>;

  beforeEach(() => {
    mockInvoke.mockReset();
    appStateMock.state = configured;
    mockSaveAppState.mockClear();
  });

  it('recognizes both Rust and legacy-webview 401 strings', () => {
    expect(isRecoverableSessionError('HTTP 401: {"code":"invalid_session"}')).toBe(true);
    expect(isRecoverableSessionError(new Error('401 Unauthorized'))).toBe(true);
    expect(isRecoverableSessionError('auth: session expired or invalid')).toBe(true);
    expect(isRecoverableSessionError('collection-gone: HTTP 404')).toBe(true);
    expect(isRecoverableSessionError('HTTP 500: nope')).toBe(false);
  });

  it('re-authenticates without disconnecting or deleting the sync state', async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'e2ee_connect') {
        return { token: 'fresh-token', userId: 'user-1', collectionId: 'collection-1' };
      }
      return undefined;
    });

    await reauthenticateE2ee('saved-password');

    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      'e2ee_stop_live',
      'e2ee_connect',
      'e2ee_password_set',
    ]);
    expect(mockInvoke).not.toHaveBeenCalledWith('e2ee_disconnect');
    expect(mockSaveAppState).toHaveBeenCalledWith(
      expect.objectContaining({
        e2eeAuthToken: 'fresh-token',
        e2eeCollectionId: 'collection-1',
      }),
    );
    expect(JSON.stringify(mockSaveAppState.mock.calls)).not.toContain('saved-password');
  });

  it('retries an active sync once with a fresh token after HTTP 401', async () => {
    await connectE2ee(configured.e2eeServerUrl!, 'saved-password');
    mockInvoke.mockReset();
    let syncRuns = 0;
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'e2ee_status') return { connected: true };
      if (command === 'e2ee_sync_run') {
        syncRuns += 1;
        if (syncRuns === 1) throw 'HTTP 401: {"code":"invalid_session"}';
        return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0 };
      }
      if (command === 'e2ee_connect') {
        return { token: 'fresh-token', userId: 'user-1', collectionId: 'collection-1' };
      }
      return undefined;
    });

    await expect(syncE2eeAuto()).resolves.toMatchObject({ uploaded: 0 });
    expect(syncRuns).toBe(2);
    expect(mockInvoke.mock.calls.map(([command]) => command)).toContain('e2ee_connect');
    expect(mockInvoke.mock.calls.map(([command]) => command)).not.toContain('e2ee_disconnect');
  });

  it('re-authenticates after a cold resume finds an expired token', async () => {
    await connectE2ee(configured.e2eeServerUrl!, 'saved-password');
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'e2ee_status') return { connected: false };
      if (command === 'e2ee_resume') throw 'HTTP 401: {"code":"invalid_session"}';
      if (command === 'e2ee_connect') {
        return { token: 'fresh-token', userId: 'user-1', collectionId: 'collection-1' };
      }
      if (command === 'e2ee_sync_run') {
        return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0 };
      }
      return undefined;
    });

    await expect(syncE2eeAuto()).resolves.toMatchObject({ downloaded: 0 });
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      'e2ee_status',
      'e2ee_resume',
      'e2ee_stop_live',
      'e2ee_connect',
      'e2ee_password_set',
      'e2ee_sync_run',
    ]);
  });
});
