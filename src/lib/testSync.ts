import { getAppState, loadAppState, saveAppState, type AppState } from './appState';
import { getCachedPreferences, type AppPreferences } from './appState';
import { requestSyncV2 } from './autoSyncV2';
import { connectE2ee, syncE2ee, disconnectE2ee, type SyncSummary } from './syncServiceE2ee';

export interface TestSyncStatus {
  preferences: AppPreferences;
  appState: AppState;
}

export interface TestSyncApi {
  connect(serverUrl: string, password: string): Promise<TestSyncStatus>;
  status(): TestSyncStatus;
  syncNow(): Promise<{ summary: SyncSummary; status: TestSyncStatus }>;
  disconnect(): Promise<TestSyncStatus>;
  connectE2ee(serverUrl: string, password: string): Promise<TestSyncStatus>;
  syncE2ee(password: string): Promise<{ summary: SyncSummary; status: TestSyncStatus }>;
  disconnectE2ee(): Promise<TestSyncStatus>;
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

export async function testConnectE2ee(
  serverUrl: string,
  password: string,
): Promise<TestSyncStatus> {
  await disconnectE2ee();
  await connectE2ee(serverUrl, password);
  return getTestSyncStatus();
}

export async function testSyncE2ee(password: string): Promise<{
  summary: SyncSummary;
  status: TestSyncStatus;
}> {
  const summary = await syncE2ee(password);
  return { summary, status: getTestSyncStatus() };
}

export async function testDisconnectE2ee(): Promise<TestSyncStatus> {
  await disconnectE2ee();
  return getTestSyncStatus();
}

export function installTestSync(target: Window = window): void {
  target.__testSync = {
    connect: testConnectSync,
    status: getTestSyncStatus,
    syncNow: testSyncNow,
    disconnect: testDisconnectSync,
    connectE2ee: testConnectE2ee,
    syncE2ee: testSyncE2ee,
    disconnectE2ee: testDisconnectE2ee,
  };
}
