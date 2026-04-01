import { getAppState, loadAppState, saveAppState, type AppState } from './appState';
import {
  connectSyncServerV2,
  type SyncSummary,
} from './syncServiceV2';
import { getCachedPreferences, type AppPreferences } from './appState';
import { requestSyncV2 } from './autoSyncV2';

export interface TestSyncStatus {
  preferences: AppPreferences;
  appState: AppState;
}

export interface TestSyncApi {
  connect(serverUrl: string, password: string): Promise<TestSyncStatus>;
  status(): TestSyncStatus;
  syncNow(): Promise<{ summary: SyncSummary; status: TestSyncStatus }>;
  disconnect(): Promise<TestSyncStatus>;
}

declare global {
  interface Window {
    __testSync?: TestSyncApi;
  }
}

async function clearServerScopedState(): Promise<void> {
  await loadAppState();
  const current = getAppState();
  await saveAppState({
    ...current,
    serverUrl: '',
    authToken: '',
    lastSyncedAt: null,
    lastSyncError: '',
    lastServerVersion: 0,
    fileHashes: {},
    hashCache: undefined,
    graphLayout: undefined,
  });
}

export function getTestSyncStatus(): TestSyncStatus {
  return {
    preferences: getCachedPreferences(),
    appState: getAppState(),
  };
}

export async function testConnectSync(
  serverUrl: string,
  password: string,
): Promise<TestSyncStatus> {
  // Server switching in tests should not carry graph cache or sync metadata
  // across unrelated backends.
  await clearServerScopedState();
  await connectSyncServerV2(serverUrl, password);
  return getTestSyncStatus();
}

export async function testSyncNow(): Promise<{
  summary: SyncSummary;
  status: TestSyncStatus;
}> {
  const summary = await requestSyncV2();
  return {
    summary,
    status: getTestSyncStatus(),
  };
}

export async function testDisconnectSync(): Promise<TestSyncStatus> {
  await clearServerScopedState();
  return getTestSyncStatus();
}

export function installTestSync(target: Window = window): void {
  target.__testSync = {
    connect: testConnectSync,
    status: getTestSyncStatus,
    syncNow: testSyncNow,
    disconnect: testDisconnectSync,
  };
}
