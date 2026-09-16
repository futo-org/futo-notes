/**
 * The hosted half of `window.__testSync` — how the cross-platform suite drives
 * Log in with FUTO, checkout, vault creation, the three unlock doors, pairing,
 * the account card, and sign out on the real desktop app.
 *
 * Two things about the shape here are deliberate.
 *
 * **It obeys `current_step`; it does not know a sequence.** `connectHosted`
 * loops: ask Rust which screen we are on, do that one thing, ask again. That is
 * the same discipline the wizard itself is held to (ADR 0003 decision 3 — no
 * shell keeps a wizard position), and it is why this is not a second copy of
 * the flow that could drift from `createHostedSyncSettings.svelte.ts`. Neither
 * file contains the order; Rust does.
 *
 * **The harness is the browser.** Sign-in and checkout finish in a browser, and
 * a test process cannot have one pop open on somebody's desktop. So instead of
 * calling `openExternalUrl`, this publishes the URL on `hostedProgress()` and
 * keeps polling the server exactly as the app does. The driver
 * (`tests/lib/standin-browser.mjs`) fetches it with a cookie jar, which is what
 * a browser contributes to the Login Hand-off chain, and the wait then
 * completes on its own — through the real `await_sign_in` / `await_entitled`
 * polling, not a shortcut past it.
 *
 * Installed only when `testHooksEnabled()` is true, alongside the rest of
 * `__testSync`.
 */

import {
  awaitHostedEntitled,
  awaitHostedSignIn,
  awaitPairing,
  beginHostedCheckout,
  beginHostedSignIn,
  beginPairing,
  completePairing,
  confirmPairing,
  createHostedVault,
  hostedBillingStatus,
  hostedCurrentStep,
  hostedSession,
  hostedSignOut,
  unlockWithRecoveryKey,
  unlockWithVaultPassword,
  type BillingStatusOutput,
  type SetupStepOutput,
} from '$lib/platform/tauri/hostedSync';

import { requestSync } from './autoSync';
import { hostedBanner, type HostedBanner } from './hostedBanner';
import { currentWriteRefusal } from './hostedWriteRefusal.svelte';
import type { WriteRefusalOutput } from './syncContract.generated';
import { connectHostedE2ee, forgetHostedE2ee } from './syncServiceE2ee';

/** Which door a `connectHosted` should take when the vault already exists. */
export type TestUnlockDoor = 'vaultPassword' | 'recoveryKey';

export interface HostedConnectOptions {
  /** The stand-in server this run is against. Required: the compiled-in
      hosted address is the real service, and a test must never reach it. */
  serverUrl: string;
  /** Used to create the vault, and to unlock through the password door. */
  vaultPassword?: string;
  /** Used by the recovery-key door — the string `create` handed back. */
  recoveryKey?: string;
  /** Which door to take if the account already has a vault. */
  door?: TestUnlockDoor;
  /**
   * Stop when Rust answers this step, without acting on it.
   *
   * The pairing scenario needs a device that is signed in and still locked —
   * the state a person is in while they hold a QR code up to their phone — and
   * there is no other way to reach it, because every other path through
   * `unlock` unlocks.
   */
  stopAtStep?: SetupStepOutput['kind'];
}

/**
 * What the driver watches while a hosted call is in flight.
 *
 * `openUrl` is the whole point: it is non-null exactly while the flow is
 * waiting on something that finishes in a browser.
 */
export interface HostedProgress {
  /** Rust's answer to "which screen", or `null` before the first read. */
  step: SetupStepOutput['kind'] | null;
  /** A URL the driver must visit for the current wait to finish. */
  openUrl: string | null;
  /** Every URL this flow asked for, in order — sign-in, then checkout. */
  opened: string[];
  /** The recovery key, for the one call that produced it. Never re-fetched. */
  recoveryKey: string | null;
  /** A live pairing code, while one is on screen. */
  pairingPayload: string | null;
  /** RFC 3339: the relay's own deadline for that code. */
  pairingExpiresAt: string | null;
  /** Mirrors the shell's four pairing states. */
  pairing: 'idle' | 'waiting' | 'received' | 'expired' | 'refused';
}

/** The account card, as the suite reads it. */
export interface HostedAccount {
  step: SetupStepOutput['kind'];
  email: string;
  billing: BillingStatusOutput | null;
  banner: HostedBanner;
}

/** The banner a refused cycle earned on its own, with no billing call. */
export interface HostedRefusalBanner {
  banner: HostedBanner;
  writeRefusal: WriteRefusalOutput | null;
}

export interface TestHostedSyncApi {
  connectHosted(options: HostedConnectOptions): Promise<HostedAccount>;
  hostedProgress(): HostedProgress;
  hostedAccount(): Promise<HostedAccount>;
  hostedRefusalBanner(): HostedRefusalBanner;
  hostedSessionToken(): Promise<string | null>;
  showPairingCode(): Promise<HostedAccount>;
  acceptPairing(scanned: string): Promise<{ deviceName: string; platform: string }>;
  hostedSignOut(): Promise<void>;
  forgetHosted(): Promise<void>;
}

/**
 * Where this device's hosted flow is pointed.
 *
 * Remembered so `forgetHosted()` can clear the secret store against the same
 * loopback address instead of the compiled-in production one — a reset between
 * scenarios must never put a request on the wire to the real service.
 */
let hostedServerUrl: string | null = null;

let progress: HostedProgress = freshProgress();

function freshProgress(): HostedProgress {
  return {
    step: null,
    openUrl: null,
    opened: [],
    recoveryKey: null,
    pairingPayload: null,
    pairingExpiresAt: null,
    pairing: 'idle',
  };
}

/** Publishes a URL the driver has to visit, and records that it was asked for. */
function waitOnBrowser(url: string): void {
  progress = { ...progress, openUrl: url, opened: [...progress.opened, url] };
}

function browserDone(): void {
  progress = { ...progress, openUrl: null };
}

export function getHostedProgress(): HostedProgress {
  return progress;
}

/**
 * This device's session token, so the suite can drive the stand-in server's
 * account controls (`POST /standin/lapse`, `POST /standin/quota`) as the
 * account that is signed in here.
 *
 * Debug builds only, like everything else on `__testSync`. The Rust hosted
 * scenarios reach for the same thing for the same reason
 * (`hosted_scenarios/mod.rs`, `lapse`): a suite needs to be the account in
 * order to lapse it, and there is no other way to be.
 */
export async function getHostedSessionToken(): Promise<string | null> {
  return (await hostedSession())?.token ?? null;
}

export async function getHostedAccount(): Promise<HostedAccount> {
  const step = await hostedCurrentStep(hostedServerUrl ?? undefined);
  progress = { ...progress, step: step.kind };
  if (step.kind === 'signIn') {
    return { step: step.kind, email: '', billing: null, banner: 'none' };
  }
  const who = await hostedSession();
  const billing = await hostedBillingStatus();
  return {
    step: step.kind,
    email: who?.email ?? '',
    billing,
    banner: hostedBanner(billing, step.kind === 'ready', currentWriteRefusal()),
  };
}

/**
 * The same rule, asked WITHOUT a billing reading — which is how the suite
 * proves the banner is there before anybody opens the account screen.
 *
 * `hostedAccount()` reads `billing_status` on every call, so it can never tell
 * a banner earned by the refusal apart from one earned by the reading it just
 * took. This is deliberately synchronous and deliberately passes `null`
 * billing: everything it answers came out of the last completed cycle.
 */
export function getHostedRefusalBanner(): HostedRefusalBanner {
  const writeRefusal = currentWriteRefusal();
  return { banner: hostedBanner(null, true, writeRefusal), writeRefusal };
}

/**
 * Runs the hosted wizard to a first sync, whatever shape the account is in.
 *
 * Step-driven, with a bound on how many transitions it will make: each branch
 * moves the flow forward exactly once and then re-reads, so a step that cannot
 * advance fails with what it was stuck on rather than spinning.
 */
export async function testConnectHosted(options: HostedConnectOptions): Promise<HostedAccount> {
  hostedServerUrl = options.serverUrl;
  progress = freshProgress();

  // Six steps is two more than the longest real path (signIn → subscribe →
  // createVault → ready). The margin absorbs a `subscribe` that answers
  // `alreadyEntitled` and re-reads without moving.
  const MAX_TRANSITIONS = 8;
  for (let transition = 0; transition < MAX_TRANSITIONS; transition += 1) {
    const step = await hostedCurrentStep(options.serverUrl);
    progress = { ...progress, step: step.kind };
    if (step.kind === options.stopAtStep) return getHostedAccount();

    switch (step.kind) {
      case 'signIn': {
        const handoff = await beginHostedSignIn(options.serverUrl);
        waitOnBrowser(handoff.url);
        const outcome = await awaitHostedSignIn(handoff);
        browserDone();
        if (outcome.kind !== 'signedIn') {
          throw new Error(`connectHosted: sign-in ended as ${outcome.kind}`);
        }
        break;
      }
      case 'subscribe': {
        const checkout = await beginHostedCheckout();
        if (checkout.kind === 'open') {
          waitOnBrowser(checkout.url);
          const outcome = await awaitHostedEntitled();
          browserDone();
          if (outcome.kind !== 'entitled') {
            throw new Error(`connectHosted: checkout ended as ${outcome.kind}`);
          }
        }
        break;
      }
      case 'createVault': {
        if (!options.vaultPassword) {
          throw new Error('connectHosted: this account has no vault, so vaultPassword is required');
        }
        // The only time the key exists. Nothing re-fetches it, here or in Rust.
        progress = { ...progress, recoveryKey: await createHostedVault(options.vaultPassword) };
        break;
      }
      case 'unlock': {
        const door = options.door ?? 'vaultPassword';
        if (door === 'recoveryKey') {
          if (!options.recoveryKey) {
            throw new Error('connectHosted: the recovery-key door needs recoveryKey');
          }
          await unlockWithRecoveryKey(options.recoveryKey);
        } else {
          if (!options.vaultPassword) {
            throw new Error('connectHosted: the vault-password door needs vaultPassword');
          }
          await unlockWithVaultPassword(options.vaultPassword);
        }
        break;
      }
      case 'ready': {
        await startSyncing();
        return getHostedAccount();
      }
    }
  }
  throw new Error(
    `connectHosted: still on "${progress.step}" after ${MAX_TRANSITIONS} transitions`,
  );
}

/**
 * Shows a pairing code and waits for the other device, on the device being set
 * up. The payload appears on `hostedProgress()` as a plain string, which is
 * what the suite passes to the other instance in place of a camera.
 */
export async function testShowPairingCode(): Promise<HostedAccount> {
  const code = await beginPairing();
  progress = {
    ...progress,
    pairing: 'waiting',
    pairingPayload: code.payload,
    pairingExpiresAt: code.expiresAt,
  };
  try {
    const outcome = await awaitPairing();
    progress = { ...progress, pairingPayload: null };
    if (outcome.kind !== 'paired') {
      progress = { ...progress, pairing: 'idle' };
      throw new Error(`showPairingCode: the wait ended as ${outcome.kind}`);
    }
    progress = { ...progress, pairing: 'received' };
  } catch (cause) {
    progress = { ...progress, pairingPayload: null };
    throw cause;
  }
  await startSyncing();
  return getHostedAccount();
}

/**
 * The scanning half, on the already-unlocked device: read the code, then send.
 *
 * Both calls, because the confirmation sheet a person taps through has no
 * automated equivalent — what it gates is `confirmPairing`, and the name this
 * returns is what that sheet would have shown.
 */
export async function testAcceptPairing(
  scanned: string,
): Promise<{ deviceName: string; platform: string }> {
  const shown = await completePairing(scanned);
  await confirmPairing();
  return { deviceName: shown.deviceName, platform: shown.platform };
}

export async function testHostedSignOut(): Promise<void> {
  await hostedSignOut(hostedServerUrl ?? undefined);
  forgetHostedE2ee();
  progress = freshProgress();
}

/**
 * Drops this device's hosted secrets between scenarios, so the next one starts
 * on a device that has never been set up.
 *
 * A no-op when nothing pointed this build at a hosted server: without a
 * remembered loopback address the sign-out would build an attempt against the
 * compiled-in production host, and a test run must not put a request on the
 * wire to the real service.
 */
export async function testForgetHosted(): Promise<void> {
  if (!hostedServerUrl) return;
  await hostedSignOut(hostedServerUrl);
  forgetHostedE2ee();
  hostedServerUrl = null;
  progress = freshProgress();
}

/** The end of the wizard: hand Rust's two secrets to the engine, run a cycle. */
async function startSyncing(): Promise<void> {
  await connectHostedE2ee();
  await requestSync();
}

export function hostedTestApi(): TestHostedSyncApi {
  return {
    connectHosted: testConnectHosted,
    hostedProgress: getHostedProgress,
    hostedAccount: getHostedAccount,
    hostedRefusalBanner: getHostedRefusalBanner,
    hostedSessionToken: getHostedSessionToken,
    showPairingCode: testShowPairingCode,
    acceptPairing: testAcceptPairing,
    hostedSignOut: testHostedSignOut,
    forgetHosted: testForgetHosted,
  };
}
