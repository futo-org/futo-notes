import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { LocalNoteMutation } from '$lib/localNoteStore';

export type ExternalFileOpenRequest =
  { kind: 'insideVault'; id: string } | { kind: 'outsideVault'; path: string; name: string };

const OPEN_NOTE_REQUEST_EVENT = 'open-note-request';

/** Install the event listener before asking for cold-launch arguments, so the
 * same handler owns both startup and later single-instance launches. */
export async function subscribeToExternalFileOpen(
  handler: (request: ExternalFileOpenRequest) => void,
): Promise<() => void> {
  const unlisten = await listen<ExternalFileOpenRequest>(OPEN_NOTE_REQUEST_EVENT, (event) =>
    handler(event.payload),
  );
  try {
    const startup = await invoke<ExternalFileOpenRequest[]>('external_file_open_requests');
    for (const request of startup) handler(request);
  } catch (error) {
    unlisten();
    throw error;
  }
  return unlisten;
}

export function importExternalNoteFile(path: string): Promise<LocalNoteMutation> {
  return invoke<LocalNoteMutation>('local_notes_import_external', { path });
}
