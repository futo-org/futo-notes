import type { HostAck, HostRequest, HostSnapshot } from '@futo-notes/editor/wasm-payloads';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { LocalNoteMutation } from '../../localNoteStore';
import { invoke } from './invoke';
import { invokeVaultCommand } from './vaultCommands';

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
  /** The note the attachment holds. */
  noteId: string;
  /** `WasmSession.restore(JSON.stringify(snapshot))`. */
  snapshot: HostSnapshot;
}

/**
 * What the host's worker did to the attached note: a save (its timer, a checkpoint, a
 * rename, a reload, the release), a timer save that failed, or a move a store workflow
 * made (a move, a sync relocation, a rename the file watcher saw). Replies and events
 * are not ordered between them; `stamp` is.
 */
export interface EditorOutcome {
  /** Increasing per attachment, in the worker's order. */
  stamp: number;
  /** The note the attachment holds after it. */
  noteId: string;
  /** The draft's revision then; when `saved`, the note holds the draft at it. */
  revision: number;
  /** The draft is on disk (written, converged, recreated or parked); false for a move,
   *  a release that discarded, and a save the test hold declined. */
  saved: boolean;
  /** The save parked the draft in `noteId`, a conflict copy; the note it left keeps its bytes. */
  parked: boolean;
  /** Apply before anything reads the notes again. */
  mutation: LocalNoteMutation | null;
  /** The note holds this source, not the draft at `revision` (an outside change merged in,
   *  or a clean draft's outside source); adopt it at `revision`. */
  offered: string | null;
  /** The save recreated the note after an outside delete; the draft was kept. */
  recreated: boolean;
  /** The timer's write failed; the Store retries, so keep typing. */
  error: string | null;
}

/** The note now attached, and how the one it replaced was released. */
export interface EditorSwitched {
  opened: EditorOpened;
  closed: EditorOutcome | null;
}

/**
 * What the commands that save reject with. Nothing changed: the note that was attached
 * still is, accepting input; retry or copy the draft.
 */
export type EditorCheckpointError = { kind: 'failed'; message: string };

// The worker requires sequence numbers in order, but concurrent Tauri commands
// can reach it in any order. Every command goes out one at a time, in the order
// the page sent it, so a checkpoint writes every edit sent before it and a
// switch cannot drop the previous note's last edits. Callers never wait on an
// ack to keep typing. Commands that save go through the vault-command path, so
// a vault that stops accepting writes raises the vault-unavailable state.
let sendChain: Promise<unknown> = Promise.resolve();

function inOrder<T>(send: () => Promise<T>): Promise<T> {
  const sent = sendChain.then(send);
  sendChain = sent.catch(() => undefined);
  return sent;
}

/** Attaches `noteId`, then releases the note attached before it: saved, or with
 *  `discard` dropped unsaved. A failure leaves the previous note attached. The note
 *  already attached is saved and read back from disk under a new token instead. */
export function editorSwitch(noteId: string, discard: boolean): Promise<EditorSwitched> {
  return inOrder(() => invokeVaultCommand<EditorSwitched>('editor_switch', { noteId, discard }));
}

/** A stale token is a page race, not a vault failure: a plain command. */
export function editorRequest(token: number, request: HostRequest): Promise<HostAck> {
  return inOrder(() => invoke<HostAck>('editor_request', { token, request }));
}

/**
 * Writes the accepted edits to Markdown now. Typing is also saved by the host's own
 * timer (500 ms after the last edit, 2 s max wait); see `onEditorSaved`.
 */
export function editorCheckpoint(token: number): Promise<EditorOutcome> {
  return inOrder(() => invokeVaultCommand<EditorOutcome>('editor_checkpoint', { token }));
}

/**
 * Saves the draft as `title` in the note's own folder, as the host knows it, in one
 * Store workflow (write and rename, or park when the note changed underneath); the
 * attachment follows it, to `noteId`.
 */
export function editorRename(token: number, title: string): Promise<EditorOutcome> {
  return inOrder(() => invokeVaultCommand<EditorOutcome>('editor_rename', { token, title }));
}

/** Saves the note `token` holds, then reads it back from disk into a fresh draft under a
 *  new token (`closed` is the save): an outside change adopted. */
export function editorReload(token: number): Promise<EditorSwitched> {
  return inOrder(() => invokeVaultCommand<EditorSwitched>('editor_reload', { token }));
}

/** Saves unsaved edits (or with `discard` drops them), then releases the note. A failed
 *  save leaves it attached. */
export function editorClose(token: number, discard: boolean): Promise<EditorOutcome> {
  return inOrder(() => invokeVaultCommand<EditorOutcome>('editor_close', { token, discard }));
}

/** The vault's note ids, for `update_note_ids` after the vault changes. */
export function editorNoteIds(): Promise<string[]> {
  return invokeVaultCommand<string[]>('editor_note_ids');
}

/** Test automation only (debug builds): while held, the attached note's saves decline
 *  without writing. */
export function editorHoldSaves(held: boolean): Promise<void> {
  return invoke<void>('editor_hold_saves', { held });
}

/** Payload of `editor:saved`: the host's timer saved, failed to, or a store workflow
 *  moved the attached note. */
export interface EditorSaved {
  token: number;
  outcome: EditorOutcome;
}

export function onEditorSaved(handler: (saved: EditorSaved) => void): Promise<UnlistenFn> {
  return listen<EditorSaved>('editor:saved', (event) => handler(event.payload));
}
