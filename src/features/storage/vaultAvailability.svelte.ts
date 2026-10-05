import { vaultStatus, type VaultStatus } from '$lib/platform/tauri';

let status = $state<VaultStatus | null>(null);
let loading: Promise<VaultStatus> | null = null;

/** Reads `vault_status` once at launch; later answers come from `recheckVaultAvailability`. */
export function loadVaultAvailability(): Promise<VaultStatus> {
  loading ??= vaultStatus().then((result) => {
    // A failed command's recheck can land first; never let the launch read undo it.
    if (status?.available !== false) status = result;
    return result;
  });
  return loading;
}

/**
 * Asks again after a note command failed: a folder that still reads can refuse
 * writes, and one can vanish mid-session. Only ever flips to unavailable — every
 * way back (Change directory, Reset, allowing the app) goes through a restart.
 */
export async function recheckVaultAvailability(): Promise<void> {
  if (status?.available === false) return;
  const result = await vaultStatus();
  if (!result.available) status = result;
}

export const vaultAvailability = {
  /** Null until the startup read lands, and on the web shell, which has no vault. */
  get status(): VaultStatus | null {
    return status;
  },
  /** Nothing can be saved: every edit, note and folder action is locked. */
  get unavailable(): boolean {
    return status?.available === false;
  },
};
