import {
  getAppState,
  getCachedPreferences,
  loadAppState,
  saveAppState,
  type AppPreferences,
  type AppState,
} from '$shared/state/appState';
import { pauseAutoSyncV2, requestSyncV2, resumeAutoSyncV2 } from './autoSyncV2';
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
    pauseAutoSync: pauseAutoSyncV2,
    resumeAutoSync: resumeAutoSyncV2,
  };
}
