import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { LicenseActionResult, LicenseLinks, LicenseView } from '../license';

// Emitted by apps/tauri/src-tauri/src/license.rs when a `futonotes://` link
// arrives while the app is already running.
const LICENSE_LINK_EVENT = 'license:link';

export async function readLicenseStatus(): Promise<LicenseView> {
  return invoke<LicenseView>('license_status');
}

export async function submitLicenseKey(input: string): Promise<LicenseActionResult> {
  return invoke<LicenseActionResult>('license_enter_key', { input });
}

export async function clearLicense(): Promise<LicenseView> {
  return invoke<LicenseView>('license_remove');
}

export async function readLicenseLinks(): Promise<LicenseLinks> {
  return invoke<LicenseLinks>('license_links');
}

// Drains a link outcome that arrived before the shell could listen — a link
// that cold-started the app. Rust `take`s it, so an outcome is delivered
// exactly once whether it reached the event or this drain.
export async function takePendingLicenseLink(): Promise<LicenseActionResult | null> {
  return invoke<LicenseActionResult | null>('license_take_pending_link');
}

// A nudge, not the outcome: the outcome is drained from Rust's inbox so a link
// is reported exactly once (see LICENSE_LINK_EVENT in license.rs).
export async function subscribeToLicenseLinks(handler: () => void): Promise<() => void> {
  return listen(LICENSE_LINK_EVENT, () => handler());
}
