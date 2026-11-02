import type { HostAck, HostRequest, HostSnapshot } from '@futo-notes/editor/wasm-payloads';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { LocalFlushDraftResult } from '../../localNoteStore';
import { invoke } from './invoke';

/**
 * Desktop host for the text-first editor (apps/tauri/src-tauri/src/editor_host.rs).
 * The page's `WasmSession` applies every edit at once and returns
 * `{change, request}`; show the change, pass the request here, and hand the
 * returned `HostAck` back to `WasmSession.acknowledge` (it returns the requests
 * to re-send after a `resume` reply, otherwise none).
 * Request/ack/snapshot shapes are the Rust serde types described in
 * `packages/editor/src/wasmPayloads.d.ts`.
 */
export type { HostAck, HostRequest, HostSnapshot };

export interface EditorOpened {
  token: number;
  /** `WasmSession.restore(JSON.stringify(snapshot))`. */
  snapshot: HostSnapshot;
  /** First `update_note_ids` delivery. */
  noteIds: string[];
}

/** Attaches `noteId`, closing any note attached before it. */
export function editorOpen(noteId: string): Promise<EditorOpened> {
  return invoke<EditorOpened>('editor_open', { noteId });
}

// The worker requires sequence numbers in order, but concurrent Tauri commands
// can reach it in any order. Send one request at a time; callers never wait on
// the returned ack to keep typing.
let sendChain: Promise<unknown> = Promise.resolve();

export function editorRequest(token: number, request: HostRequest): Promise<HostAck> {
  const sent = sendChain.then(() => invoke<HostAck>('editor_request', { token, request }));
  sendChain = sent.catch(() => undefined);
  return sent;
}

/**
 * What `editorCheckpoint` and `editorClose` reject with. The note stays
 * attached and accepting input; retry or copy the draft.
 */
export type EditorCheckpointError = { kind: 'failed'; message: string };

/**
 * Writes the accepted edits to Markdown now. Typing is also saved by the host's
 * own timer (500 ms after the last edit, 2 s max wait); see `onEditorSaved`.
 */
export function editorCheckpoint(token: number): Promise<LocalFlushDraftResult> {
  return invoke<LocalFlushDraftResult>('editor_checkpoint', { token });
}

/** Saves unsaved edits, then releases the note. A failed save leaves it attached. */
export function editorClose(token: number): Promise<LocalFlushDraftResult> {
  return invoke<LocalFlushDraftResult>('editor_close', { token });
}

/** The vault's note ids, for `update_note_ids` after the vault changes. */
export function editorNoteIds(): Promise<string[]> {
  return invoke<string[]>('editor_note_ids');
}

/** Payload of the `editor:saved` event the host's save timer emits. */
export interface EditorSaved {
  token: number;
  /** Set when the timer wrote the note; apply its mutation like any save. */
  result: LocalFlushDraftResult | null;
  /** Set when the write failed; the Store retries, so keep typing. */
  error: string | null;
}

export function onEditorSaved(handler: (saved: EditorSaved) => void): Promise<UnlistenFn> {
  return listen<EditorSaved>('editor:saved', (event) => handler(event.payload));
}
