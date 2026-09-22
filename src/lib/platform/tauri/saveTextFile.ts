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
}

/**
 * Returns `true` when a file was written, `false` when the person cancelled.
 * A cancel is an outcome, not a failure; anything else throws.
 */
export async function saveTextFile(request: SaveTextFileRequest): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({
    defaultPath: request.suggestedName,
    filters: [{ name: request.filterName, extensions: request.extensions }],
  });
  if (typeof path !== 'string') return false;
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');
  await writeTextFile(path, request.contents);
  return true;
}
