// Shared setup for the sync-password unit tests: the platform, toast and keyring
// mocks (the keyring is an in-memory stand-in for the Rust e2ee_* commands), the
// fresh/reboot module loaders, and the per-test reset. A test file imports this
// BEFORE the modules under test so its mocks are in place.
import { vi } from 'vitest';

// Real testFS-backed platform mock, but pretend we're on desktop (Tauri) so
// the password store talks to the (mocked) keyring commands.
vi.mock('$lib/platform', async () => {
  const mod = await vi.importActual<typeof import('$lib/platform/__mocks__/index')>(
    '$lib/platform/__mocks__/index',
  );
  return { ...mod, isLinux: false, isTauri: true };
});

// Capture toasts (K3 surfaces delete failures through showGlobalToast).
// vitest forbids exporting a hoisted variable, so the mock factories read these
// private objects and the tests get the same objects through the exports below.
const hoistedToast = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock('$shared/notifications/toastBus.svelte', () => ({
  showGlobalToast: (message: unknown) => hoistedToast.messages.push(message),
  currentToastMessage: () => '',
}));

// Configurable in-memory stand-in for the OS keyring exposed by the Rust
// e2ee_password_* commands. `gate` lets a test hold an op mid-flight;
// `fail` forces a rejection to model an unavailable / erroring secret store.
const hoistedKr = vi.hoisted(() => ({
  store: new Map<string, string>(),
  gate: { set: null, get: null, delete: null } as Record<string, Promise<void> | null>,
  fail: { set: false, get: false, delete: false } as Record<string, boolean>,
  // Whether this device has hosted secrets Rust could resume — the local
  // secret-store read `e2ee_hosted_has_saved_vault` answers at boot.
  hostedVault: false,
  // How many times the Rust SSE loop was actually asked to start.
  liveStarts: 0,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'e2ee_password_set':
        if (hoistedKr.gate.set) await hoistedKr.gate.set;
        if (hoistedKr.fail.set) throw new Error('keyring set failed');
        hoistedKr.store.set('pw', args!.password as string);
        return undefined;
      case 'e2ee_password_get':
        if (hoistedKr.gate.get) await hoistedKr.gate.get;
        if (hoistedKr.fail.get) throw new Error('keyring get failed');
        return hoistedKr.store.get('pw') ?? null;
      case 'e2ee_password_delete':
        if (hoistedKr.gate.delete) await hoistedKr.gate.delete;
        if (hoistedKr.fail.delete) throw new Error('keyring delete failed');
        hoistedKr.store.delete('pw');
        return undefined;
      case 'e2ee_session_token_set':
        if (hoistedKr.fail.set) throw new Error('keyring set failed');
        hoistedKr.store.set('token', args!.token as string);
        return undefined;
      case 'e2ee_session_token_get':
        if (hoistedKr.fail.get) throw new Error('keyring get failed');
        return hoistedKr.store.get('token') ?? null;
      case 'e2ee_session_token_delete':
        if (hoistedKr.fail.delete) throw new Error('keyring delete failed');
        hoistedKr.store.delete('token');
        return undefined;
      case 'e2ee_start_live':
        hoistedKr.liveStarts += 1;
        return undefined;
      case 'e2ee_hosted_has_saved_vault':
        return hoistedKr.hostedVault;
      case 'e2ee_hosted_connect':
        // What Rust's `HostedSetup::connect_sync` does as of the C12 fix:
        // starting a hosted session drops this vault's self-hosted password,
        // so exactly one sync credential exists at a time. Modeled here
        // because the delete happens inside the engine, not in TypeScript.
        hoistedKr.store.delete('pw');
        return undefined;
      case 'e2ee_connect':
        return { userId: 'u', collectionId: 'c', token: 't', authMode: 'password' };
      case 'e2ee_status':
        return { connected: false, maxVersion: 0, objectCount: 0 };
      // e2ee_disconnect / e2ee_stop_live / e2ee_resume / … → no-op
      default:
        return undefined;
    }
  }),
}));

export const toastMock = hoistedToast;
export const kr = hoistedKr;

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let all currently-queued microtasks + a macrotask tick drain. */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Fresh modules AND a wiped vault + keyring — a clean install. */
export async function fresh() {
  vi.resetModules();
  const platform = await import('$lib/platform');
  platform.testFS._reset();
  kr.store.clear();
  const appState = await import('$shared/state/appState');
  const svc = await import('$features/sync/syncServiceE2ee');
  return { platform, appState, svc };
}

/** Fresh modules but keep the on-disk vault + keyring — a relaunch. */
export async function reboot() {
  vi.resetModules();
  const platform = await import('$lib/platform');
  const appState = await import('$shared/state/appState');
  const svc = await import('$features/sync/syncServiceE2ee');
  return { platform, appState, svc };
}

export function seedAppState(extra: Record<string, unknown>): string {
  return JSON.stringify({
    deviceId: 'device-1',
    e2eeServerUrl: 'http://server',
    e2eeAuthToken: 'token',
    e2eeUserId: 'user',
    e2eeCollectionId: 'collection',
    ...extra,
  });
}

export const PREFS = {
  appearance: {
    theme: 'dark' as const,
  },
  language: { selectedLanguageTag: null },
  crashReporting: { enabled: true, alwaysSend: false },
  updates: { enabled: true },
  sync: { serverUrl: '', token: '', lastSyncedAt: null, lastError: '' },
};

/** How many times `e2ee_start_live` reached the (mocked) engine. */
export function liveStartCount(): number {
  return kr.liveStarts;
}

export async function resetPasswordHarness(): Promise<void> {
  const platform = await import('$lib/platform');
  platform.resetActiveFS(); // undo any custom FS a prior test installed
  kr.store.clear();
  kr.gate.set = kr.gate.get = kr.gate.delete = null;
  kr.fail.set = kr.fail.get = kr.fail.delete = false;
  kr.hostedVault = false;
  kr.liveStarts = 0;
  toastMock.messages = [];
}
