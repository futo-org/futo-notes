import {
  getAppState,
  getCachedPreferences,
  loadAppState,
  saveAppState,
  type AppPreferences,
  type AppState,
} from '$shared/state/appState';
import { pauseAutoSync, requestSync, resumeAutoSync } from './autoSync';
import { connectE2ee, disconnectE2ee, type SyncSummary } from './syncServiceE2ee';

export interface TestSyncStatus {
  preferences: AppPreferences;
  appState: AppState;
}

export interface TestSyncApi {
  connect(serverUrl: string, password: string): Promise<TestSyncStatus>;
  status(): TestSyncStatus;
  syncNow(): Promise<{ summary: SyncSummary; status: TestSyncStatus }>;
  disconnect(): Promise<TestSyncStatus>;
  pauseAutoSync(): Promise<void>;
  resumeAutoSync(): void;
}

declare global {
  interface Window {
    __testSync?: TestSyncApi;
  }
}

async function clearServerScopedState(): Promise<void> {
  await loadAppState();
  await disconnectE2ee();
  const current = getAppState();
  await saveAppState({
    ...current,
    lastSyncedAt: null,
    lastSyncError: '',
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
  await clearServerScopedState();
  await connectE2ee(serverUrl, password);
  return getTestSyncStatus();
}

export async function testSyncNow(): Promise<{
  summary: SyncSummary;
  status: TestSyncStatus;
}> {
  const summary = await requestSync();
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
    pauseAutoSync,
    resumeAutoSync,
  };
}
