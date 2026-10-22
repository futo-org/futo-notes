/**
 * "Save file": a Save-as dialog plus one text write, as one OS capability.
 *
 * It exists because the recovery-key screen is the one place in the app where
 * a person has to get bytes *out* of it and onto their own disk, and losing
 * those bytes loses the vault. Components never reach for the dialog or the
 * filesystem themselves (`just check-platform-discipline`), so the whole
 * gesture lives here.
 */

export interface SaveTextFileRequest {
  /** Pre-filled filename, extension included. */
  suggestedName: string;
  /** Shown as the file-type filter's name; already localized by the caller. */
  filterName: string;
  /** Extensions the filter accepts, without dots. */
  extensions: string[];
  contents: string;
  /**
   * Where to write, in place of the dialog: the agent's `SaveRecoveryKey`. Never over an
   * existing file — the dialog would have asked before replacing one.
   */
  path?: string;
}

/**
 * Returns `true` when a file was written, `false` when the person canceled.
 * A cancel is an outcome, not a failure; anything else throws.
 */
export async function saveTextFile(request: SaveTextFileRequest): Promise<boolean> {
  const { exists, writeTextFile } = await import('@tauri-apps/plugin-fs');
  if (request.path !== undefined && (await exists(request.path))) {
    throw new Error(`${request.path} already exists`);
  }
  const path = request.path ?? (await pickPath(request));
  if (typeof path !== 'string') return false;
  await writeTextFile(path, request.contents);
  return true;
}

async function pickPath(request: SaveTextFileRequest): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({
    defaultPath: request.suggestedName,
    filters: [{ name: request.filterName, extensions: request.extensions }],
  });
}
