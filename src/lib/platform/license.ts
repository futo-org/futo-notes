// The platform boundary for the paid client license.
//
// Every license *rule* lives in the `futo-notes-license` Rust crate and is
// projected by `apps/tauri/src-tauri/src/license.rs`. Nothing here parses a
// key, verifies an activation, judges expiry, or decides a message — this file
// only moves typed results across the IPC boundary, so no rule gets a second
// implementation in TypeScript (AGENTS.md M6).
//
// Off Tauri — the web dev server and the native mobile editor embed — there is
// no desktop license surface, so every call answers "Unlicensed" rather than
// making each caller branch on platform (§4.5).

import { platformName } from './index';

export type LicenseStateName = 'unlicensed' | 'licensed' | 'expired';

/** What the License row renders. Timestamps are RFC 3339; the *formatting* is
 *  the frontend's job, because only it knows the user's locale. */
export interface LicenseView {
  state: LicenseStateName;
  /** The source of "Supporter since {year}". */
  issuedAt: string | null;
  /** `null` for a perpetual license. */
  expiresAt: string | null;
  /** The stored license key, normalized by the Rust crate — the same string
   *  the desktop license file holds. The card shows it masked and reveals it
   *  on request, so it crosses the boundary instead of being read back out of
   *  storage here. `null` whenever the state is `unlicensed`. */
  key: string | null;
}

/** Which toast an action earned. `invalid` covers both a key the server does
 *  not know and a pair that does not verify — the spec gives them one message. */
export type LicenseOutcome = 'activated' | 'invalid' | 'offline';

export interface LicenseActionResult {
  outcome: LicenseOutcome;
  view: LicenseView;
}

export interface LicenseLinks {
  buy: string;
  support: string;
}

export const UNLICENSED: LicenseView = {
  state: 'unlicensed',
  issuedAt: null,
  expiresAt: null,
  key: null,
};

export async function readLicenseStatus(): Promise<LicenseView> {
  if (platformName !== 'tauri') return UNLICENSED;
  const { readLicenseStatus: read } = await import('./tauri/license');
  return read();
}

/** Recognise, activate if the input was a bare key, verify, and store — one
 *  Rust call. The shell never sequences activate-then-verify (§4.6).
 *
 *  Off Tauri this is NOT a verdict on the input — nothing here judges a license
 *  (M6). It is "there is no license surface on this platform", which only the
 *  web dev server ever reaches; the shipping desktop, iOS and Android surfaces
 *  all have a real implementation behind them. */
export async function submitLicenseKey(input: string): Promise<LicenseActionResult> {
  if (platformName !== 'tauri') return { outcome: 'invalid', view: UNLICENSED };
  const { submitLicenseKey: submit } = await import('./tauri/license');
  return submit(input);
}

export async function clearLicense(): Promise<LicenseView> {
  if (platformName !== 'tauri') return UNLICENSED;
  const { clearLicense: clear } = await import('./tauri/license');
  return clear();
}

/** The Buy / Renew and "Lost your key?" destinations, read from the Rust crate
 *  so no shell hardcodes a URL and every platform agrees. */
export async function readLicenseLinks(): Promise<LicenseLinks> {
  if (platformName !== 'tauri') return { buy: '', support: '' };
  const { readLicenseLinks: read } = await import('./tauri/license');
  return read();
}

export async function takePendingLicenseLink(): Promise<LicenseActionResult | null> {
  if (platformName !== 'tauri') return null;
  const { takePendingLicenseLink: take } = await import('./tauri/license');
  return take();
}

/** Subscribes to "a link was handled" nudges. The outcome itself comes from
 *  {@link takePendingLicenseLink}, so a link is never reported twice.
 *
 *  Deliberately async: the caller must be able to wait until the listener is
 *  actually attached before it drains, or a link parked in the gap between the
 *  drain and the (dynamically imported) `listen` is reported by neither, and
 *  sits in the inbox until the next launch. */
export async function subscribeLicenseLinks(handler: () => void): Promise<() => void> {
  if (platformName !== 'tauri') return () => {};
  const { subscribeToLicenseLinks } = await import('./tauri/license');
  return subscribeToLicenseLinks(handler);
}
