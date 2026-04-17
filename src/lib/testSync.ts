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
  connectE2ee(serverUrl: string, email: string, name: string, password: string): Promise<TestSyncStatus>;
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
  // Legacy V2 connect signature — delegate to E2EE with default email
  await autoSignupForTest(serverUrl, 'dev@test.com', 'Dev', password);
  await connectE2ee(serverUrl, 'dev@test.com', 'Dev', password);
  return getTestSyncStatus();
}

/**
 * Test-only: ensure the given user exists on the server before login.
 * In production, users sign up at <server>/start in the browser.
 */
async function autoSignupForTest(
  serverUrl: string,
  email: string,
  name: string,
  password: string,
): Promise<void> {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  try {
    await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    // 201 = created, 409 = already exists — either way proceed to login.
  } catch {
    // Network error — let connectE2ee surface it.
  }
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

async function clearE2eeState(): Promise<void> {
  await disconnectE2ee();
}

export async function testConnectE2ee(
  serverUrl: string,
  email: string,
  name: string,
  password: string,
): Promise<TestSyncStatus> {
  await clearE2eeState();
  await autoSignupForTest(serverUrl, email, name, password);
  await connectE2ee(serverUrl, email, name, password);
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
  await clearE2eeState();
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
