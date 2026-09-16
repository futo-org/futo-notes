// @vitest-environment jsdom
//
// The launch half of hosted sync: a hosted desktop vault must hand its secrets
// to the engine during the boot credential load, so `isE2eeConfigured()` is
// already true when auto-sync's first cycle is released. Before this, only
// `connectHostedE2ee()` from the Settings account card ever set that flag, so a
// restart did not sync until the person opened Settings. → docs/spec/sync.md
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real testFS-backed platform mock, but pretend we're on desktop (Tauri): the
// whole hosted flow is `e2ee_hosted_*` Tauri commands.
vi.mock('$lib/platform', async () => {
  const mod = await vi.importActual<typeof import('$lib/platform/__mocks__/index')>(
    '$lib/platform/__mocks__/index',
  );
  return { ...mod, isTauri: true };
});

vi.mock('$shared/notifications/toastBus.svelte', () => ({
  showGlobalToast: () => {},
  currentToastMessage: () => '',
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

/** The Rust side, as far as this module can see it. */
const rust = vi.hoisted(() => ({
  /** What `e2ee_hosted_has_saved_vault` answers. */
  savedVault: false,
  /** Set to make `e2ee_hosted_connect` reject — the offline-at-launch case. */
  connectFails: false,
  /** Set to make `e2ee_hosted_has_saved_vault` itself reject. */
  savedVaultFails: false,
  calls: [] as string[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    rust.calls.push(cmd);
    switch (cmd) {
      case 'e2ee_password_get':
        return null;
      case 'e2ee_hosted_has_saved_vault':
        if (rust.savedVaultFails) throw new Error('secret store unavailable');
        return rust.savedVault;
      case 'e2ee_hosted_connect':
        if (rust.connectFails) throw new Error('error sending request: connection refused');
        return undefined;
      case 'e2ee_status':
        return { connected: false, maxVersion: 0, objectCount: 0 };
      case 'e2ee_sync_run':
        return { pushed: 0, pulled: 0, conflicts: 0, failures: [] };
      default:
        return undefined;
    }
  }),
}));

function countCalls(cmd: string): number {
  return rust.calls.filter((c) => c === cmd).length;
}

/** Fresh module registry + a wiped vault — a cold launch. */
async function launch() {
  vi.resetModules();
  const platform = await import('$lib/platform');
  platform.resetActiveFS();
  platform.testFS._reset();
  rust.calls = [];
  const svc = await import('$features/sync/syncServiceE2ee');
  const auto = await import('$features/sync/autoSync');
  return { platform, svc, auto };
}

beforeEach(() => {
  rust.savedVault = false;
  rust.connectFails = false;
  rust.savedVaultFails = false;
  // A debug build, which is what turns the hosted flow on.
  vi.stubEnv('DEV', true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hosted sync resumes at launch, not on the first Settings visit', () => {
  it('connects the saved hosted vault before the first cycle is released', async () => {
    const { svc } = await launch();
    rust.savedVault = true;

    // What auto-sync sees at the instant it stops waiting — the only moment
    // that decides whether the launch syncs or not.
    let configuredAtSettle: boolean | null = null;
    const settled = svc.whenSyncCredentialsSettled().then(() => {
      configuredAtSettle = svc.isE2eeConfigured();
    });

    await svc.initSyncPassword();
    await settled;

    expect(countCalls('e2ee_hosted_connect')).toBe(1);
    expect(configuredAtSettle).toBe(true);
    expect(svc.isE2eeConfigured()).toBe(true);
  });

  it('asks Rust locally first, and leaves a vault that is not hosted alone', async () => {
    const { svc } = await launch();
    rust.savedVault = false;

    await svc.initSyncPassword();

    expect(countCalls('e2ee_hosted_has_saved_vault')).toBe(1);
    expect(countCalls('e2ee_hosted_connect')).toBe(0);
    expect(svc.isE2eeConfigured()).toBe(false);
  });

  it('never asks at all in a build without the hosted flow', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_HOSTED_SYNC', undefined);
    const { svc } = await launch();
    rust.savedVault = true;

    await svc.initSyncPassword();

    expect(countCalls('e2ee_hosted_has_saved_vault')).toBe(0);
    expect(countCalls('e2ee_hosted_connect')).toBe(0);
    expect(svc.isE2eeConfigured()).toBe(false);
  });

  it('settles anyway when the launch connect fails, and records the vault for a retry', async () => {
    const { svc } = await launch();
    rust.savedVault = true;
    rust.connectFails = true;

    // A launch with no network must not hold auto-sync's first cycle hostage.
    await expect(svc.initSyncPassword()).resolves.toBeUndefined();
    await expect(svc.whenSyncCredentialsSettled()).resolves.toBeUndefined();

    expect(countCalls('e2ee_hosted_connect')).toBe(1);
    // The vault IS configured — this process just has not handed its secrets
    // over yet. Reporting "not configured" here is exactly what made auto-sync
    // skip the vault entirely until Settings was opened.
    expect(svc.isE2eeConfigured()).toBe(true);
  });

  it('retries the connect on the next sync, with no scheduler of its own', async () => {
    const { svc } = await launch();
    rust.savedVault = true;
    rust.connectFails = true;
    await svc.initSyncPassword();
    expect(countCalls('e2ee_hosted_connect')).toBe(1);

    // Back online: the ordinary sync path rebuilds the session, exactly as it
    // does for a hosted session this process did connect.
    rust.connectFails = false;
    await expect(svc.syncE2eeAuto()).resolves.toMatchObject({ failures: [] });

    expect(countCalls('e2ee_hosted_connect')).toBe(2);
  });

  it('leaves the vault unconfigured when the local read itself fails', async () => {
    const { svc } = await launch();
    rust.savedVaultFails = true;

    await expect(svc.initSyncPassword()).resolves.toBeUndefined();

    expect(countCalls('e2ee_hosted_connect')).toBe(0);
    expect(svc.isE2eeConfigured()).toBe(false);
  });

  it('forgetting the hosted vault stops it being resumed', async () => {
    const { svc } = await launch();
    rust.savedVault = true;
    await svc.initSyncPassword();
    expect(svc.isE2eeConfigured()).toBe(true);

    await svc.forgetHostedE2ee();

    expect(svc.isE2eeConfigured()).toBe(false);
  });

  it('a disconnect drops the resumed session too', async () => {
    const { svc } = await launch();
    rust.savedVault = true;
    await svc.initSyncPassword();
    expect(svc.isE2eeConfigured()).toBe(true);

    await svc.disconnectE2ee();

    expect(svc.isE2eeConfigured()).toBe(false);
  });
});

describe("auto-sync's first cycle is what the launch connect is for", () => {
  it('runs a cycle at launch without anything opening the account card', async () => {
    const { svc, auto } = await launch();
    rust.savedVault = true;
    const onSyncComplete = vi.fn();

    auto.startAutoSync({
      onSyncComplete,
      onSyncError: vi.fn(),
      flushPendingSave: async () => {},
    });
    await svc.initSyncPassword();
    // Let the settled-promise continuation and the cycle it starts run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(countCalls('e2ee_sync_run')).toBe(1);
    expect(onSyncComplete).toHaveBeenCalledTimes(1);
    auto.stopAutoSync();
  });

  it('retries the connect on the initial ladder when the launch connect failed', async () => {
    vi.useFakeTimers();
    try {
      const { svc, auto } = await launch();
      rust.savedVault = true;
      rust.connectFails = true;
      const onSyncError = vi.fn();

      auto.startAutoSync({
        onSyncComplete: vi.fn(),
        onSyncError,
        flushPendingSave: async () => {},
      });
      await svc.initSyncPassword();
      await vi.advanceTimersByTimeAsync(0);

      // The launch cycle tried, and failed on the connect rather than being
      // skipped as "not configured".
      expect(countCalls('e2ee_hosted_connect')).toBe(2);
      expect(onSyncError).toHaveBeenCalledTimes(1);

      // The existing initial-retry ladder carries the retry; nothing new
      // schedules it.
      rust.connectFails = false;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(countCalls('e2ee_sync_run')).toBe(1);
      auto.stopAutoSync();
    } finally {
      vi.useRealTimers();
    }
  });
});
