import { vaultStatus, type VaultStatus } from '$lib/platform/tauri';

let status = $state<VaultStatus | null>(null);
let loading: Promise<VaultStatus> | null = null;

/**
 * Reads `vault_status` once per launch. Every answer after that needs a
 * restart anyway: the watcher and the note list bind the vault only at startup,
 * and every way out of an unusable vault (Change directory, Reset) relaunches.
 */
export function loadVaultAvailability(): Promise<VaultStatus> {
  loading ??= vaultStatus().then((result) => (status = result));
  return loading;
}

export const vaultAvailability = {
  /** Null until the startup read lands, and on the web shell, which has no vault. */
  get status(): VaultStatus | null {
    return status;
  },
  /** Nothing can be saved: creating a note or folder would only lose what the user types. */
  get unavailable(): boolean {
    return status?.available === false;
  },
};
