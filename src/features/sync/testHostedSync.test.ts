import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SetupStepOutput } from '$lib/platform/tauri/hostedSync';

/**
 * A stand-in for the hosted engine: the same facts Rust derives `current_step`
 * from, and the calls that change them. The tests below drive `connectHosted`
 * against it, so what they prove is that the hook follows whatever step it is
 * told — never that it replays a sequence of its own.
 */
const engine = vi.hoisted(() => {
  const state = {
    signedIn: false,
    entitled: false,
    hasVault: false,
    unlocked: false,
    calls: [] as string[],
    /** URLs handed out, so a test can prove the wait ended on the real poll. */
    signInVisited: false,
    checkoutVisited: false,
  };
  return state;
});

const hostedMocks = vi.hoisted(() => ({
  hostedCurrentStep: vi.fn(),
  beginHostedSignIn: vi.fn(),
  awaitHostedSignIn: vi.fn(),
  beginHostedCheckout: vi.fn(),
  awaitHostedEntitled: vi.fn(),
  createHostedVault: vi.fn(),
  unlockWithVaultPassword: vi.fn(),
  unlockWithRecoveryKey: vi.fn(),
  hostedSession: vi.fn(),
  hostedBillingStatus: vi.fn(),
  beginPairing: vi.fn(),
  awaitPairing: vi.fn(),
  completePairing: vi.fn(),
  confirmPairing: vi.fn(),
  hostedSignOut: vi.fn(),
}));

const syncMocks = vi.hoisted(() => ({
  connectHostedE2ee: vi.fn(),
  forgetHostedE2ee: vi.fn(),
  requestSync: vi.fn(),
}));

vi.mock('$lib/platform/tauri/hostedSync', () => hostedMocks);
vi.mock('./syncServiceE2ee', () => ({
  connectHostedE2ee: syncMocks.connectHostedE2ee,
  forgetHostedE2ee: syncMocks.forgetHostedE2ee,
}));
vi.mock('./autoSync', () => ({ requestSync: syncMocks.requestSync }));

const SERVER = 'http://127.0.0.1:4242';

function currentStep(): SetupStepOutput {
  if (!engine.signedIn) return { kind: 'signIn' };
  if (!engine.hasVault && !engine.entitled) return { kind: 'subscribe' };
  if (!engine.hasVault) return { kind: 'createVault' };
  if (!engine.unlocked) return { kind: 'unlock' };
  return { kind: 'ready' };
}

function wireEngine() {
  hostedMocks.hostedCurrentStep.mockImplementation(async () => currentStep());

  hostedMocks.beginHostedSignIn.mockImplementation(async () => ({
    url: `${SERVER}/handoff/t1`,
    ticket: 't1',
  }));
  // The wait answers from the same fact a real poll would read: the browser
  // has to have visited the URL before a session exists. It polls rather than
  // answering at once, so the driver's visit really does happen DURING the
  // wait — which is the ordering the harness depends on.
  hostedMocks.awaitHostedSignIn.mockImplementation(async () => {
    if (!(await pollUntil(() => engine.signInVisited))) return { kind: 'expired' as const };
    engine.signedIn = true;
    return { kind: 'signedIn' as const, session: session() };
  });

  hostedMocks.beginHostedCheckout.mockImplementation(async () =>
    engine.entitled
      ? ({ kind: 'alreadyEntitled', status: status() } as const)
      : ({ kind: 'open', url: `${SERVER}/checkout/c1` } as const),
  );
  hostedMocks.awaitHostedEntitled.mockImplementation(async () => {
    if (!(await pollUntil(() => engine.checkoutVisited))) {
      return { kind: 'gaveUp' as const, status: status() };
    }
    engine.entitled = true;
    return { kind: 'entitled' as const, status: status() };
  });

  hostedMocks.createHostedVault.mockImplementation(async () => {
    engine.calls.push('createVault');
    engine.hasVault = true;
    engine.unlocked = true;
    return 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345';
  });
  hostedMocks.unlockWithVaultPassword.mockImplementation(async () => {
    engine.calls.push('unlockWithVaultPassword');
    engine.unlocked = true;
  });
  hostedMocks.unlockWithRecoveryKey.mockImplementation(async () => {
    engine.calls.push('unlockWithRecoveryKey');
    engine.unlocked = true;
  });

  hostedMocks.hostedSession.mockImplementation(async () => session());
  hostedMocks.hostedBillingStatus.mockImplementation(async () => status());

  hostedMocks.beginPairing.mockImplementation(async () => ({
    payload: '{"futo_notes_pairing":1,"id":"p1"}',
    expiresAt: '2026-09-16T00:05:00Z',
  }));
  hostedMocks.awaitPairing.mockImplementation(async () => {
    engine.unlocked = true;
    return { kind: 'paired' as const };
  });
  hostedMocks.completePairing.mockImplementation(async () => {
    engine.calls.push('completePairing');
    return { deviceName: 'Kitchen laptop', platform: 'desktop' };
  });
  hostedMocks.confirmPairing.mockImplementation(async () => {
    engine.calls.push('confirmPairing');
  });
  hostedMocks.hostedSignOut.mockImplementation(async (url?: string) => {
    engine.calls.push(`signOut:${url ?? 'compiled-in'}`);
    engine.signedIn = false;
    engine.unlocked = false;
  });
}

/** Waits for the driver's visit the way the engine waits for the server. */
async function pollUntil(done: () => boolean, attempts = 200): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return false;
}

function session() {
  return { userId: 'u1', email: 'person@standin.test', name: 'Stand-in Person', token: 'tok' };
}

function status() {
  return {
    entitled: engine.entitled,
    state: engine.entitled ? 'active' : 'expired',
    graceUntil: null,
    storageQuotaBytes: 1_000,
    blobMaxBytes: 100,
    bytesUsed: 10,
  };
}

async function freshModule() {
  vi.resetModules();
  return import('./testHostedSync');
}

/** Runs a hosted call with a browser that visits whatever URL is published. */
async function withBrowser<T>(
  hook: typeof import('./testHostedSync'),
  work: () => Promise<T>,
): Promise<T> {
  const running = work();
  const visit = setInterval(() => {
    const url = hook.getHostedProgress().openUrl;
    if (url?.includes('/handoff/')) engine.signInVisited = true;
    if (url?.includes('/checkout/')) engine.checkoutVisited = true;
  }, 1);
  try {
    return await running;
  } finally {
    clearInterval(visit);
  }
}

describe('testHostedSync', () => {
  beforeEach(() => {
    Object.assign(engine, {
      signedIn: false,
      entitled: false,
      hasVault: false,
      unlocked: false,
      calls: [],
      signInVisited: false,
      checkoutVisited: false,
    });
    for (const mock of Object.values(hostedMocks)) mock.mockReset();
    for (const mock of Object.values(syncMocks)) mock.mockReset();
    wireEngine();
  });

  it('runs the no-vault shape to a first sync, through a browser for each wait', async () => {
    const hook = await freshModule();

    const account = await withBrowser(hook, () =>
      hook.testConnectHosted({ serverUrl: SERVER, vaultPassword: 'a long enough password' }),
    );

    expect(hook.getHostedProgress().opened).toEqual([
      `${SERVER}/handoff/t1`,
      `${SERVER}/checkout/c1`,
    ]);
    expect(hook.getHostedProgress().recoveryKey).toBe('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345');
    expect(account.step).toBe('ready');
    expect(account.email).toBe('person@standin.test');
    expect(syncMocks.connectHostedE2ee).toHaveBeenCalledTimes(1);
    expect(syncMocks.requestSync).toHaveBeenCalledTimes(1);
  });

  it('runs the vault-exists shape by vault password, with no subscribe step', async () => {
    engine.hasVault = true;
    const hook = await freshModule();

    const account = await withBrowser(hook, () =>
      hook.testConnectHosted({ serverUrl: SERVER, vaultPassword: 'a long enough password' }),
    );

    expect(engine.calls).toEqual(['unlockWithVaultPassword']);
    expect(hook.getHostedProgress().opened).toEqual([`${SERVER}/handoff/t1`]);
    expect(hostedMocks.beginHostedCheckout).not.toHaveBeenCalled();
    expect(account.step).toBe('ready');
  });

  it('runs the vault-exists shape by recovery key', async () => {
    engine.hasVault = true;
    const hook = await freshModule();

    await withBrowser(hook, () =>
      hook.testConnectHosted({
        serverUrl: SERVER,
        door: 'recoveryKey',
        recoveryKey: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345',
      }),
    );

    expect(engine.calls).toEqual(['unlockWithRecoveryKey']);
  });

  // The hook holds no wizard position of its own: pointed at a device that is
  // already set up, it does nothing but start syncing.
  it('starts syncing without a sign-in when Rust already answers ready', async () => {
    Object.assign(engine, { signedIn: true, entitled: true, hasVault: true, unlocked: true });
    const hook = await freshModule();

    const account = await hook.testConnectHosted({ serverUrl: SERVER });

    expect(hostedMocks.beginHostedSignIn).not.toHaveBeenCalled();
    expect(engine.calls).toEqual([]);
    expect(account.step).toBe('ready');
  });

  it('refuses to create a vault it was given no password for', async () => {
    const hook = await freshModule();

    await expect(
      withBrowser(hook, () => hook.testConnectHosted({ serverUrl: SERVER })),
    ).rejects.toThrow(/vaultPassword is required/);
  });

  it('publishes a pairing code as a string and syncs once the key arrives', async () => {
    Object.assign(engine, { signedIn: true, entitled: true, hasVault: true });
    const hook = await freshModule();

    const account = await hook.testShowPairingCode();

    expect(hook.getHostedProgress().pairingExpiresAt).toBe('2026-09-16T00:05:00Z');
    // Cleared once the wait ends — a spent code is not still on screen.
    expect(hook.getHostedProgress().pairingPayload).toBeNull();
    expect(hook.getHostedProgress().pairing).toBe('received');
    expect(account.step).toBe('ready');
    expect(syncMocks.requestSync).toHaveBeenCalledTimes(1);
  });

  it('reads a scanned code before sending anything', async () => {
    const hook = await freshModule();

    const shown = await hook.testAcceptPairing('{"futo_notes_pairing":1,"id":"p1"}');

    expect(shown.deviceName).toBe('Kitchen laptop');
    expect(engine.calls).toEqual(['completePairing', 'confirmPairing']);
  });

  it('signs out against the server it was pointed at, not the compiled-in one', async () => {
    Object.assign(engine, { signedIn: true, entitled: true, hasVault: true, unlocked: true });
    const hook = await freshModule();

    await hook.testConnectHosted({ serverUrl: SERVER });
    await hook.testHostedSignOut();

    expect(engine.calls).toEqual([`signOut:${SERVER}`]);
    expect(syncMocks.forgetHostedE2ee).toHaveBeenCalled();
  });

  // Otherwise a reset on a build that never ran a hosted scenario would build
  // an attempt against notes-sync.futo.org and put a request on the wire.
  it('forgets nothing when no hosted server was ever named', async () => {
    const hook = await freshModule();

    await hook.testForgetHosted();

    expect(hostedMocks.hostedSignOut).not.toHaveBeenCalled();
  });

  it('forgets the secrets against the named server once one is known', async () => {
    Object.assign(engine, { signedIn: true, entitled: true, hasVault: true, unlocked: true });
    const hook = await freshModule();

    await hook.testConnectHosted({ serverUrl: SERVER });
    await hook.testForgetHosted();
    await hook.testForgetHosted();

    expect(engine.calls).toEqual([`signOut:${SERVER}`]);
  });

  it('reports the account card the way the sync screen does', async () => {
    Object.assign(engine, { signedIn: true, hasVault: true, unlocked: true, entitled: false });
    const hook = await freshModule();

    const account = await hook.getHostedAccount();

    expect(account.step).toBe('ready');
    expect(account.banner).toBe('syncPaused');
    expect(account.billing?.entitled).toBe(false);
  });
});
