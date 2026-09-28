import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';

let vaultCommandFailed: () => void = () => {};

/** Every vault command that fails reports here — the only sign that a vault which
 *  still reads refuses writes, or that one went missing mid-session. */
export function onVaultCommandFailed(listener: () => void): void {
  vaultCommandFailed = listener;
}

/** A command that reads or writes the vault: notes, app data, images. */
export function invokeVaultCommand<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  return invoke<T>(command, args, options).catch((error: unknown) => {
    vaultCommandFailed();
    throw error;
  });
}
