import type { NoteSyncMeta } from './note.js';

// ── Sync ───────────────────────────────────────────────

export interface InventoryItem {
  uuid: string;
  content_hash: string;
  filename: string;
  modified_at: number;
}

export interface SyncRequest {
  /** Only notes that changed client-side (content_hash !== hash_at_last_sync). */
  notes: NoteSyncMeta[];
  /** All UUIDs with their current hashes — server uses to detect its own changes. */
  inventory: InventoryItem[];
  /** UUIDs the client has deleted since last sync. */
  deleted_uuids: string[];
  /** Last-seen sync version from server. */
  version?: number;
}

export interface SyncResponse {
  /** Notes the client should create or update. */
  update: NoteSyncMeta[];
  /** UUIDs the client should delete locally. */
  delete: string[];
  /** Hash confirmations so client can update hash_at_last_sync. */
  hash_updates: { uuid: string; hash_at_last_sync: string }[];
  /** Conflict copies created on the server — client should download on next sync. */
  conflicts: {
    uuid: string;
    server_filename: string;
    client_filename: string;
    client_content: string;
  }[];
  /** Monotonic version — client stores this and uses /sync/check to skip no-op syncs. */
  version?: number;
}

// ── Sync Check ────────────────────────────────────────

export interface SyncCheckRequest {
  version: number;
}

export interface SyncCheckResponse {
  status: 'up_to_date' | 'changes_available';
  version: number;
}

// ── Auth ───────────────────────────────────────────────

export interface SetupRequest {
  password: string;
}

export interface LoginRequest {
  password: string;
  device_info?: string;
}

export interface LoginResponse {
  token: string;
}

export interface RevokeRequest {
  mode: 'current' | 'all' | 'specific';
  /** Required when mode === 'specific'. */
  token_hashes?: string[];
}

export interface RevokeResponse {
  revoked: number;
}

// ── Health ─────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok';
  setup_complete: boolean;
}

// ── Errors ─────────────────────────────────────────────

export interface ErrorResponse {
  error: string;
}
