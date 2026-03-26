import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { contentHash } from '../../src/sync/hash.js';
import { authReq } from './setup.js';

// ── Response types (matching @futo-notes/shared with content field) ──

export interface SyncResponseUpdate {
  uuid: string;
  filename: string;
  content: string;
  modified_at: number;
  content_hash: string;
  hash_at_last_sync: string;
}

export interface SyncResponseConflict {
  uuid: string;
  server_filename: string;
  client_filename: string;
  client_content: string;
}

export interface SyncResponse {
  update: SyncResponseUpdate[];
  delete: string[];
  hash_updates: { uuid: string; hash_at_last_sync: string }[];
  conflicts: SyncResponseConflict[];
  version: number;
}

// ── SyncClient ──────────────────────────────────────────

export class SyncClient {
  private app: Hono;
  private token: string;

  // Client-side state (matches real client's syncState.ts)
  notes: Map<string, { content: string; filename: string; modified_at: number }> = new Map();
  hashByUuid: Map<string, string> = new Map();
  uuidByFilename: Map<string, string> = new Map();
  deletedUuids: Set<string> = new Set();
  serverVersion: number = 0;

  constructor(app: Hono, token: string) {
    this.app = app;
    this.token = token;
  }

  createNote(filename: string, content: string, modified_at?: number): string {
    const uuid = crypto.randomUUID();
    const mtime = modified_at ?? Date.now();
    this.notes.set(uuid, { content, filename, modified_at: mtime });
    this.uuidByFilename.set(filename, uuid);
    return uuid;
  }

  editNote(uuid: string, newContent: string, modified_at?: number): void {
    const note = this.notes.get(uuid);
    if (!note) throw new Error(`Note ${uuid} not found`);
    note.content = newContent;
    note.modified_at = modified_at ?? Date.now();
  }

  deleteNote(uuid: string): void {
    const note = this.notes.get(uuid);
    if (note) {
      this.uuidByFilename.delete(note.filename);
      this.notes.delete(uuid);
    }
    this.deletedUuids.add(uuid);
    this.hashByUuid.delete(uuid);
  }

  renameNote(uuid: string, newFilename: string, modified_at?: number): void {
    const note = this.notes.get(uuid);
    if (!note) throw new Error(`Note ${uuid} not found`);
    this.uuidByFilename.delete(note.filename);
    note.filename = newFilename;
    note.modified_at = modified_at ?? Date.now();
    this.uuidByFilename.set(newFilename, uuid);
  }

  async sync(): Promise<SyncResponse> {
    // Build V2 sync request
    const notesPayload: {
      uuid: string;
      filename: string;
      modified_at: number;
      content_hash: string;
      hash_at_last_sync: string;
      content: string;
    }[] = [];
    const inventory: {
      uuid: string;
      content_hash: string;
      filename: string;
      modified_at: number;
    }[] = [];

    for (const [uuid, note] of this.notes) {
      const hash = contentHash(note.content);
      const hashAtLastSync = this.hashByUuid.get(uuid) ?? '';

      if (hash !== hashAtLastSync) {
        // Content changed — send full note
        notesPayload.push({
          uuid,
          filename: note.filename,
          modified_at: note.modified_at,
          content_hash: hash,
          hash_at_last_sync: hashAtLastSync,
          content: note.content,
        });
      }

      inventory.push({
        uuid,
        content_hash: hash,
        filename: note.filename,
        modified_at: note.modified_at,
      });
    }

    const body = {
      notes: notesPayload,
      deleted_uuids: [...this.deletedUuids],
      inventory,
      version: this.serverVersion,
    };

    const res = await authReq(this.app, 'POST', '/sync', this.token, body);
    const data = (await res.json()) as SyncResponse;

    // Apply response to client state

    // Handle deletes
    for (const uuid of data.delete) {
      const note = this.notes.get(uuid);
      if (note) {
        this.uuidByFilename.delete(note.filename);
        this.notes.delete(uuid);
      }
      this.hashByUuid.delete(uuid);
    }

    // Handle updates from server
    for (const update of data.update) {
      const existing = this.notes.get(update.uuid);
      if (existing) {
        this.uuidByFilename.delete(existing.filename);
      }
      const filename = update.filename;
      this.notes.set(update.uuid, {
        content: update.content,
        filename,
        modified_at: update.modified_at,
      });
      this.uuidByFilename.set(filename, update.uuid);
      this.hashByUuid.set(update.uuid, update.content_hash);
    }

    // Handle hash_updates (server confirms our content)
    for (const hu of data.hash_updates) {
      this.hashByUuid.set(hu.uuid, hu.hash_at_last_sync);
    }

    // Handle conflicts — the conflict copy is a new server-side note
    // that gets delivered in update[]. The conflicts[] array is metadata only.
    // No additional client-side state changes needed here since the new note
    // is already handled in the update loop above.

    // Clear deletedUuids after sync
    this.deletedUuids.clear();

    // Update version
    this.serverVersion = data.version;

    return data;
  }

  async syncCheck(): Promise<{ status: string; version: number }> {
    const res = await authReq(this.app, 'POST', '/sync/check', this.token, {
      version: this.serverVersion,
    });
    return (await res.json()) as { status: string; version: number };
  }

  getNote(uuid: string) {
    return this.notes.get(uuid);
  }

  getNoteByFilename(filename: string) {
    const uuid = this.uuidByFilename.get(filename);
    if (!uuid) return undefined;
    return { uuid, ...this.notes.get(uuid)! };
  }

  getSyncState() {
    return {
      notes: new Map(this.notes),
      hashByUuid: new Map(this.hashByUuid),
      uuidByFilename: new Map(this.uuidByFilename),
      deletedUuids: new Set(this.deletedUuids),
      serverVersion: this.serverVersion,
    };
  }
}
