import type { HostAck, HostRequest, HostSnapshot } from '@futo-notes/editor/wasm-payloads';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { LocalFlushDraftResult } from '../../localNoteStore';
import { invoke } from './invoke';

/**
 * Desktop host for the text-first editor (apps/tauri/src-tauri/src/editor_host.rs).
 * The page's `WasmSession` produces each `HostRequest`; pass it here and hand
 * the returned `HostAck` back to `WasmSession.acknowledge`, one at a time.
 * Request/ack/snapshot shapes are the Rust serde types described in
 * `packages/editor/src/wasmPayloads.d.ts`.
 */
export type { HostAck, HostRequest, HostSnapshot };

export interface EditorRecoveryIssue {
  kind:
    | 'TornTail'
    | 'CorruptRecord'
    | 'InvalidEdit'
    | 'SequenceMismatch'
    | 'IdentityMismatch'
    | 'UnsupportedVersion'
    | 'BaseMismatch';
  /** Zero for the header, one-based for edit records. */
  record: number;
  version: number | null;
}

export interface EditorOpened {
  token: number;
  /** `WasmSession.restore(JSON.stringify(snapshot))`. */
  snapshot: HostSnapshot;
  recoveryIssue: EditorRecoveryIssue | null;
  /** First `update_note_ids` delivery. */
  noteIds: string[];
}

/** Attaches `noteId`, closing any note attached before it. */
export function editorOpen(noteId: string): Promise<EditorOpened> {
  return invoke<EditorOpened>('editor_open', { noteId });
}

export function editorRequest(token: number, request: HostRequest): Promise<HostAck> {
  return invoke<HostAck>('editor_request', { token, request });
}

/**
 * What `editorCheckpoint` rejects with. `committed`: the Markdown is on disk
 * but recovery retirement or its durability check failed; apply `result`'s
 * mutation, then retry the checkpoint.
 */
export type EditorCheckpointError =
  | { kind: 'failed'; message: string }
  | { kind: 'committed'; result: LocalFlushDraftResult; message: string };

/** Writes the accepted draft to Markdown (the only save path while attached). */
export function editorCheckpoint(token: number): Promise<LocalFlushDraftResult> {
  return invoke<LocalFlushDraftResult>('editor_checkpoint', { token });
}

/** Flushes accepted edits to recovery and releases the note. No Markdown save. */
export function editorClose(token: number): Promise<void> {
  return invoke<void>('editor_close', { token });
}

/** The vault's note ids, for `update_note_ids` after the vault changes. */
export function editorNoteIds(): Promise<string[]> {
  return invoke<string[]>('editor_note_ids');
}

/** The recovery flush deadline for `token` passed: send `WasmSession.flush()`. */
export function onEditorFlushDue(handler: (token: number) => void): Promise<UnlistenFn> {
  return listen<number>('editor:flush-due', (event) => handler(event.payload));
}
