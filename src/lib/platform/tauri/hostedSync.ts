/**
 * The desktop IPC surface for hosted sync setup.
 *
 * Every function here forwards one `e2ee_hosted_*` Tauri command and nothing
 * else. The sequence — which screen comes next, what a restart resumes to,
 * when a secret is kept — belongs to `futo_notes_sync::HostedSetup` and is
 * never reconstructed on this side (ADR 0003, decision 11). In particular
 * `currentStep` is the only source of the wizard's position: no caller may
 * remember one.
 *
 * The types come from the generated Rust IPC contract, which is why this is a
 * type-only import of a file that happens to live under `features/sync`.
 */

import { invoke } from '@tauri-apps/api/core';

import type {
  BillingStatusOutput,
  CheckoutOutput,
  EntitlementOutcomeOutput,
  HostedSessionOutput,
  PairingCodeOutput,
  PairingOutcomeOutput,
  ScannedPairingOutput,
  SetupStepOutput,
  SignInFlowOutput,
  SignInHandoffOutput,
  SignInOutcomeOutput,
} from '$features/sync/syncContract.generated';

export type {
  BillingStatusOutput,
  CheckoutOutput,
  EntitlementOutcomeOutput,
  HostedSessionOutput,
  PairingCodeOutput,
  PairingOutcomeOutput,
  ScannedPairingOutput,
  SetupStepOutput,
  SignInFlowOutput,
  SignInHandoffOutput,
  SignInOutcomeOutput,
};

/** Where hosted sync lives. Compiled into Rust; a debug build may differ. */
export function hostedServerUrl(): Promise<string> {
  return invoke<string>('e2ee_hosted_server_url');
}

/** Which sign-in a server wants, read from its capability document. */
export function probeSignInFlow(serverUrl: string): Promise<SignInFlowOutput> {
  return invoke<SignInFlowOutput>('e2ee_hosted_probe', { serverUrl });
}

/** Mints a Login Hand-off. Open `url` in the system browser, then await it. */
export function beginHostedSignIn(serverUrl?: string): Promise<SignInHandoffOutput> {
  return invoke<SignInHandoffOutput>('e2ee_hosted_begin_sign_in', { serverUrl: serverUrl ?? null });
}

export function awaitHostedSignIn(handoff: SignInHandoffOutput): Promise<SignInOutcomeOutput> {
  return invoke<SignInOutcomeOutput>('e2ee_hosted_await_sign_in', { handoff });
}

/** Stops whichever wait is running — what closing the browser window means. */
export function cancelHostedWait(): Promise<void> {
  return invoke<void>('e2ee_hosted_cancel_wait');
}

export function hostedSession(): Promise<HostedSessionOutput | null> {
  return invoke<HostedSessionOutput | null>('e2ee_hosted_session');
}

export function hostedBillingStatus(): Promise<BillingStatusOutput> {
  return invoke<BillingStatusOutput>('e2ee_hosted_billing_status');
}

export function beginHostedCheckout(): Promise<CheckoutOutput> {
  return invoke<CheckoutOutput>('e2ee_hosted_begin_checkout');
}

/** A fresh one-shot customer-portal URL, minted per press. */
export function hostedBillingPortal(): Promise<string> {
  return invoke<string>('e2ee_hosted_billing_portal');
}

export function awaitHostedEntitled(): Promise<EntitlementOutcomeOutput> {
  return invoke<EntitlementOutcomeOutput>('e2ee_hosted_await_entitled');
}

/**
 * Which screen the wizard is on, derived by Rust from server facts and this
 * device's secret store. Safe as the first call on a cold start.
 */
export function hostedCurrentStep(serverUrl?: string): Promise<SetupStepOutput> {
  return invoke<SetupStepOutput>('e2ee_hosted_current_step', { serverUrl: serverUrl ?? null });
}

/** The shortest vault password Rust will create a vault with. */
export function minVaultPasswordLength(): Promise<number> {
  return invoke<number>('e2ee_hosted_min_vault_password_length');
}

/**
 * Creates the vault and answers with its recovery key.
 *
 * **The only time that key exists.** Nothing in Rust keeps a copy and a second
 * call is refused, so whatever the caller does with this string is the only
 * chance a person gets to save it.
 */
export function createHostedVault(vaultPassword: string): Promise<string> {
  return invoke<string>('e2ee_hosted_create_vault', { vaultPassword });
}

export function unlockWithVaultPassword(vaultPassword: string): Promise<void> {
  return invoke<void>('e2ee_hosted_unlock_with_vault_password', { vaultPassword });
}

export function unlockWithRecoveryKey(typed: string): Promise<void> {
  return invoke<void>('e2ee_hosted_unlock_with_recovery_key', { typed });
}

/**
 * Sets a new vault password, from the account card.
 *
 * Asks for no current secret: this device already holds the vault key, and a
 * device paired by QR never knew the old password. The vault key itself does
 * not change, so every other device carries on untouched.
 *
 * Rejects with `vaultKeyChangedElsewhere` when another device re-wrapped in
 * between. Nothing was overwritten; calling this again lands.
 */
export function changeVaultPassword(newPassword: string): Promise<void> {
  return invoke<void>('e2ee_hosted_change_vault_password', { newPassword });
}

/**
 * Issues a new recovery key and answers with it, for the same save screen the
 * wizard uses.
 *
 * **The old key stops working.** Like `createHostedVault`, nothing in Rust
 * keeps a copy, so this string is the only chance a person gets to save it.
 */
export function newRecoveryKey(): Promise<string> {
  return invoke<string>('e2ee_hosted_new_recovery_key');
}

/**
 * Opens a pairing and returns the code for this device to show as a QR.
 *
 * Called on the **new** device — the one with no vault key. Start
 * `awaitPairing()` as soon as the code is on screen. The one-time keypair's
 * private half never leaves Rust.
 *
 * `deviceName` is what the other device's confirmation sheet will say. Left
 * out, Rust uses this computer's own name, which is the only thing the desktop
 * frontend could ask for anyway.
 */
export function beginPairing(deviceName?: string): Promise<PairingCodeOutput> {
  return invoke<PairingCodeOutput>('e2ee_hosted_begin_pairing', {
    deviceName: deviceName ?? null,
  });
}

/**
 * Reads a scanned pairing code, on the **unlocked** device. Parsing only:
 * nothing is sent and no vault key is touched, so a wrong scan costs a message.
 *
 * Rust keeps the scan. What comes back is the name for the confirmation sheet
 * and nothing else — there is no pairing id or public key on this side to post
 * a vault key to, which is what makes the sheet a real gate.
 */
export function completePairing(scanned: string): Promise<ScannedPairingOutput> {
  return invoke<ScannedPairingOutput>('e2ee_hosted_complete_pairing', { scanned });
}

/** The confirm step: seals the vault key to the held scan and posts it. */
export function confirmPairing(): Promise<void> {
  return invoke<void>('e2ee_hosted_confirm_pairing');
}

/**
 * Waits on the **new** device for the other one to answer, then keeps the key.
 * `paired` means the vault is unlocked; `cancelHostedWait()` ends the wait.
 */
export function awaitPairing(): Promise<PairingOutcomeOutput> {
  return invoke<PairingOutcomeOutput>('e2ee_hosted_await_pairing');
}

/**
 * Hands this vault's hosted secrets to the sync engine, so a cycle can run.
 * The step after the wizard reaches `ready`, whichever door got it there.
 * Safe to call again — it rebuilds the session from the same two secrets.
 */
export function connectHostedSync(serverUrl?: string): Promise<void> {
  return invoke<void>('e2ee_hosted_connect', { serverUrl: serverUrl ?? null });
}

/**
 * Whether this vault has hosted secrets to resume, read from the OS secret
 * store with no network call. What boot asks before deciding to connect —
 * `hostedCurrentStep` asks the server, so offline it cannot answer this.
 */
export function hasHostedSavedVault(serverUrl?: string): Promise<boolean> {
  return invoke<boolean>('e2ee_hosted_has_saved_vault', { serverUrl: serverUrl ?? null });
}

/** Revokes the session, forgets key and token, and demotes sync state. */
export function hostedSignOut(serverUrl?: string): Promise<void> {
  return invoke<void>('e2ee_hosted_sign_out', { serverUrl: serverUrl ?? null });
}
