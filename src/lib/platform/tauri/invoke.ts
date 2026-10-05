import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import { toWellFormedDeep } from '@futo-notes/editor';

/**
 * `invoke` for every desktop command. The one difference: strings in the
 * arguments are made well-formed first, each lone surrogate becoming U+FFFD
 * (RC-48, maintainer decision 16A).
 *
 * WebKitGTK cannot reach Tauri's custom-protocol IPC, so its commands travel by
 * `window.ipc.postMessage`. A message whose JSON carries a lone surrogate (an
 * escaped `\ud800`) fails serde's parse in tauri's `handle_ipc_message`, and that
 * path only logs to the console: neither callback runs, the promise never
 * settles, and a save that sent it waited for ever with no toast. Repairing the
 * text at this boundary means nothing ill-formed reaches the parser, whatever
 * produced it (the editor, a title field, a password).
 */
export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  // Only the arguments the caller gave: `invoke(cmd)` stays `invoke(cmd)`.
  if (args === undefined) return tauriInvoke<T>(cmd);
  const repaired = toWellFormedDeep(args);
  return options === undefined
    ? tauriInvoke<T>(cmd, repaired)
    : tauriInvoke<T>(cmd, repaired, options);
}
