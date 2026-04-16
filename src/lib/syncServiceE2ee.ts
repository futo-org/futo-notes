/**
 * E2EE sync service — talks to the POC encrypted sync server.
 *
 * Protocol: REST API with collections, objects (version-tracked), and blobs (opaque encrypted).
 * All note content is encrypted client-side before upload. The server never sees plaintext.
 */

import { getAppState, saveAppState } from './appState';
import { applySyncDeltaV2 } from './rustCore';
import { getPlatformFS } from './platform';
import {
  PBKDF2_ITERATIONS,
  deriveKey,
  encrypt,
  decrypt,
  packNote,
  unpackNote,
  generateSalt,
  generateVaultKey,
  exportKeyBytes,
  importVaultKey,
  toHex,
  fromHex,
} from './e2eeCrypto';
// ── In-memory key cache (derived on connect, cleared on disconnect) ──────

let cachedKey: CryptoKey | null = null;

// ── Types ────────────────────────────────────────────────────────────────

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  updatedIds: string[];
  deletedIds: string[];
  renamed: Array<{ fromId: string; toId: string }>;
}

interface ServerObject {
  id: string;
  collection_id: string;
  version: string | number;
  change_seq: string | number;
  deleted: boolean;
  blob_key: string | null;
  size_bytes: string | number | null;
  created_at: string;
  updated_at: string;
}

interface ObjectWriteResponse {
  object: {
    id: string;
    version: string | number;
    change_seq?: string | number;
  };
  collectionVersion?: number;
}

interface ConflictResponse {
  error: string;
  currentVersion: number;
  currentBlobKey: string | null;
}

interface PullResult {
  downloaded: number;
  deleted: number;
  updatedIds: string[];
  deletedIds: string[];
  newMaxVersion: number;
  /** Filenames added/updated this pull keyed by content hash — used to detect remote renames. */
  hashToFilename: Map<string, string>;
  /** Filenames deleted by this pull keyed by their last-known content hash — used to detect remote renames. */
  deletedHashes: Map<string, string>;
}

interface PushResult {
  uploaded: number;
  deleted: number;
  conflicts: number;
  updatedIds: string[];
  deletedIds: string[];
  newMaxVersion: number;
  deletedHashes: Map<string, string>;
}

interface KeyMaterial {
  key_salt: string;
  key_kdf: {
    kdf: 'pbkdf2-sha256';
    iterations: number;
    hash: 'SHA-256';
  };
  encrypted_vault_key: string;
  key_updated_at?: string | null;
}

interface KeyMaterialResponse {
  key: KeyMaterial | null;
}

type E2eeObjectMap = NonNullable<ReturnType<typeof getAppState>['e2eeObjectMap']>;
type E2eeObjectMapEntry = E2eeObjectMap[string];

type MergeAttempt =
  | { clean: true; content: string }
  | { clean: false };

// ── Fetch helper ─────────────────────────────────────────────────────────

const TIMEOUT_MS = 30_000;

function getE2eeConfig(): { serverUrl: string; token: string; userId: string; collectionId: string } {
  const s = getAppState();
  if (!s.e2eeServerUrl || !s.e2eeAuthToken || !s.e2eeCollectionId || !s.e2eeUserId) {
    throw new Error('E2EE sync not configured');
  }
  return {
    serverUrl: s.e2eeServerUrl,
    token: s.e2eeAuthToken,
    userId: s.e2eeUserId,
    collectionId: s.e2eeCollectionId,
  };
}

async function e2eeFetch(url: string, init?: RequestInit): Promise<Response> {
  const { token } = getE2eeConfig();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function e2eeJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await e2eeFetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`E2EE server error: HTTP ${res.status} ${body}`);
  }
  return res.json();
}

// ── Helpers ──────────────────────────────────────────────────────────────

function filenameToId(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(hash));
}

function splitLineTokens(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

interface MergeHunk {
  baseStart: number;
  baseEnd: number;
  replacement: string[];
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function diffHunks(base: string[], target: string[]): MergeHunk[] {
  const dp = Array.from({ length: base.length + 1 }, () => Array<number>(target.length + 1).fill(0));
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = target.length - 1; j >= 0; j--) {
      dp[i][j] = base[i] === target[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const hunks: MergeHunk[] = [];
  let i = 0;
  let j = 0;
  let pending: MergeHunk | null = null;

  const startPending = (): MergeHunk => {
    if (!pending) {
      pending = { baseStart: i, baseEnd: i, replacement: [] };
    }
    return pending;
  };

  const flush = () => {
    if (pending) {
      hunks.push(pending);
      pending = null;
    }
  };

  while (i < base.length || j < target.length) {
    if (i < base.length && j < target.length && base[i] === target[j]) {
      flush();
      i++;
      j++;
    } else if (j < target.length && (i === base.length || dp[i][j + 1] >= dp[i + 1][j])) {
      startPending().replacement.push(target[j]);
      j++;
    } else {
      startPending().baseEnd = i + 1;
      i++;
    }
  }
  flush();

  return hunks;
}

function hunksConflict(a: MergeHunk, b: MergeHunk): boolean {
  const sameRange = a.baseStart === b.baseStart && a.baseEnd === b.baseEnd;
  if (sameRange && sameStringArray(a.replacement, b.replacement)) return false;

  // Two insertions at the exact same point need ordering semantics. Stay
  // conservative and surface a conflict unless they inserted identical text.
  if (a.baseStart === a.baseEnd && b.baseStart === b.baseEnd) {
    return a.baseStart === b.baseStart;
  }

  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

function threeWayMergeText(base: string, remote: string, local: string): MergeAttempt {
  if (remote === local) return { clean: true, content: remote };
  if (base === remote) return { clean: true, content: local };
  if (base === local) return { clean: true, content: remote };

  const baseLines = splitLineTokens(base);
  const remoteHunks = diffHunks(baseLines, splitLineTokens(remote));
  const localHunks = diffHunks(baseLines, splitLineTokens(local));

  for (const remoteHunk of remoteHunks) {
    for (const localHunk of localHunks) {
      if (hunksConflict(remoteHunk, localHunk)) {
        return { clean: false };
      }
    }
  }

  const mergedHunks: MergeHunk[] = [];
  for (const hunk of [...remoteHunks, ...localHunks]) {
    if (!mergedHunks.some((existing) =>
      existing.baseStart === hunk.baseStart &&
      existing.baseEnd === hunk.baseEnd &&
      sameStringArray(existing.replacement, hunk.replacement)
    )) {
      mergedHunks.push(hunk);
    }
  }

  mergedHunks.sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);

  const output: string[] = [];
  let cursor = 0;
  for (const hunk of mergedHunks) {
    output.push(...baseLines.slice(cursor, hunk.baseStart));
    output.push(...hunk.replacement);
    cursor = hunk.baseEnd;
  }
  output.push(...baseLines.slice(cursor));

  return { clean: true, content: output.join('') };
}

function conflictFilename(original: string, existing: Set<string>): string {
  const date = new Date().toISOString().slice(0, 10);
  const base = original.endsWith('.md') ? original.slice(0, -3) : original.replace(/\.[^.]*$/, '');
  const ext = original.includes('.') ? original.slice(base.length) : '.md';
  let candidate = `${base} (conflict ${date})${ext || '.md'}`;
  let counter = 2;
  while (existing.has(candidate)) {
    candidate = `${base} (conflict ${date} ${counter})${ext || '.md'}`;
    counter++;
  }
  return candidate;
}

async function downloadNoteByBlobKey(key: CryptoKey, blobKey: string): Promise<{ filename: string; content: string }> {
  const { serverUrl } = getE2eeConfig();
  const blobRes = await e2eeFetch(`${serverUrl}/api/blobs/${blobKey}`);
  if (!blobRes.ok) {
    throw new Error(`Failed to download blob ${blobKey}: HTTP ${blobRes.status}`);
  }
  const ciphertext = new Uint8Array(await blobRes.arrayBuffer());
  const plaintext = await decrypt(key, ciphertext);
  return unpackNote(plaintext);
}

async function uploadNoteBlob(key: CryptoKey, filename: string, content: string): Promise<{ blobKey: string; sizeBytes: number }> {
  const { serverUrl } = getE2eeConfig();
  const packed = packNote(filename, content);
  const ciphertext = await encrypt(key, packed);
  const blobRes = await e2eeFetch(`${serverUrl}/api/blobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext as BodyInit,
  });
  if (!blobRes.ok) {
    throw new Error(`Failed to upload blob for ${filename}: HTTP ${blobRes.status}`);
  }
  const blobData = await blobRes.json() as { key: string };
  return { blobKey: blobData.key, sizeBytes: ciphertext.byteLength };
}

async function createObjectForNote(
  key: CryptoKey,
  filename: string,
  content: string,
): Promise<{ objectId: string; version: number; blobKey: string; hash: string; changeSeq: number }> {
  const { serverUrl, collectionId } = getE2eeConfig();
  const uploaded = await uploadNoteBlob(key, filename, content);
  const createRes = await e2eeFetch(
    `${serverUrl}/api/collections/${collectionId}/objects`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blob_key: uploaded.blobKey,
        size_bytes: uploaded.sizeBytes,
      }),
    },
  );
  if (!createRes.ok) {
    throw new Error(`Failed to create object for ${filename}: HTTP ${createRes.status}`);
  }
  const createData = await createRes.json() as ObjectWriteResponse;
  return {
    objectId: createData.object.id,
    version: Number(createData.object.version),
    blobKey: uploaded.blobKey,
    hash: await sha256(content),
    changeSeq: Number(createData.collectionVersion ?? createData.object.change_seq ?? 0),
  };
}

async function fetchKeyMaterial(
  baseUrl: string,
  token: string,
  collectionId: string,
): Promise<KeyMaterial | null> {
  const res = await fetch(`${baseUrl}/api/collections/${collectionId}/key`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch vault key: HTTP ${res.status} ${body}`);
  }
  const data = await res.json() as KeyMaterialResponse;
  return data.key;
}

async function saveKeyMaterial(
  baseUrl: string,
  token: string,
  collectionId: string,
  material: KeyMaterial,
): Promise<KeyMaterial> {
  const res = await fetch(`${baseUrl}/api/collections/${collectionId}/key`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(material),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to save vault key: HTTP ${res.status} ${body}`);
  }
  const data = await res.json() as { key: KeyMaterial };
  return data.key;
}

async function createWrappedVaultKey(password: string): Promise<{ key: CryptoKey; material: KeyMaterial }> {
  const vaultKey = await generateVaultKey();
  const salt = generateSalt();
  const passwordKey = await deriveKey(password, salt);
  const rawVaultKey = await exportKeyBytes(vaultKey);
  const encryptedVaultKey = await encrypt(passwordKey, rawVaultKey);
  return {
    key: vaultKey,
    material: {
      key_salt: toHex(salt),
      key_kdf: {
        kdf: 'pbkdf2-sha256',
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      encrypted_vault_key: toHex(encryptedVaultKey),
    },
  };
}

async function unwrapVaultKey(password: string, material: KeyMaterial): Promise<CryptoKey> {
  if (material.key_kdf.kdf !== 'pbkdf2-sha256' || material.key_kdf.hash !== 'SHA-256') {
    throw new Error(`Unsupported vault key KDF: ${material.key_kdf.kdf}`);
  }
  if (material.key_kdf.iterations !== PBKDF2_ITERATIONS) {
    console.warn(
      `[e2ee] Vault key uses ${material.key_kdf.iterations} PBKDF2 iterations; current client default is ${PBKDF2_ITERATIONS}`,
    );
  }
  const passwordKey = await deriveKey(password, fromHex(material.key_salt), material.key_kdf.iterations);
  try {
    const rawVaultKey = await decrypt(passwordKey, fromHex(material.encrypted_vault_key));
    return await importVaultKey(rawVaultKey);
  } catch {
    throw new Error('Could not unlock vault key. Check your vault password.');
  }
}

async function unlockConfiguredVaultKey(password: string): Promise<CryptoKey> {
  const { serverUrl, token, collectionId } = getE2eeConfig();
  const material = await fetchKeyMaterial(serverUrl, token, collectionId);
  if (!material) {
    throw new Error('Vault key material is missing on the server');
  }
  return unwrapVaultKey(password, material);
}

// ── Connect ──────────────────────────────────────────────────────────────

export async function connectE2ee(
  serverUrl: string,
  email: string,
  name: string,
  password: string,
): Promise<void> {
  const baseUrl = serverUrl.replace(/\/+$/, '');

  // 1. Log in with email + password (account must be created via ${baseUrl}/start first).
  void name;
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (loginRes.status === 401) {
    throw new Error(`Login failed. Did you sign up at ${baseUrl}/start yet?`);
  }
  if (!loginRes.ok) {
    throw new Error(`Login failed: HTTP ${loginRes.status}`);
  }
  const loginData = await loginRes.json() as { user: { id: string }; token: string };
  const token = loginData.token;
  const userId = loginData.user.id;

  // 2. Find or create a collection (vault)
  const headers = { Authorization: `Bearer ${token}` };
  const listRes = await fetch(`${baseUrl}/api/collections`, { headers });
  const listData = await listRes.json() as { collections: Array<{ id: string }> };

  let collectionId: string;
  if (listData.collections.length > 0) {
    collectionId = listData.collections[0].id;
  } else {
    const createRes = await fetch(`${baseUrl}/api/collections`, { method: 'POST', headers });
    const createData = await createRes.json() as { collection: { id: string } };
    collectionId = createData.collection.id;
  }

  // 3. Create or unlock the stable vault key. The server only stores the
  // password-wrapped key material; it never sees the plaintext vault key.
  let material = await fetchKeyMaterial(baseUrl, token, collectionId);
  let vaultKey: CryptoKey;
  if (material) {
    vaultKey = await unwrapVaultKey(password, material);
  } else {
    const created = await createWrappedVaultKey(password);
    vaultKey = created.key;
    material = await saveKeyMaterial(baseUrl, token, collectionId, created.material);
  }
  cachedKey = vaultKey;

  // 4. Persist state
  const current = getAppState();
  await saveAppState({
    ...current,
    e2eeServerUrl: baseUrl,
    e2eeEmail: email,
    e2eeAuthToken: token,
    e2eeUserId: userId,
    e2eeCollectionId: collectionId,
    e2eeSalt: material.key_salt,
    e2eeObjectMap: current.e2eeObjectMap ?? {},
    e2eeMaxVersion: current.e2eeMaxVersion ?? 0,
  });

  console.log(`[e2ee] Connected to ${baseUrl}, collection=${collectionId}, user=${userId}`);
}

// ── Disconnect ───────────────────────────────────────────────────────────

/** Check whether E2EE sync is configured and the key is in memory. */
export function isE2eeConfigured(): boolean {
  const s = getAppState();
  return Boolean(s.e2eeServerUrl && s.e2eeAuthToken && s.e2eeCollectionId && cachedKey);
}

/** Sync using the in-memory key (for auto-sync). Throws if not connected. */
export async function syncE2eeAuto(): Promise<SyncSummary> {
  if (!cachedKey) {
    // Try to re-derive from stored salt if we have a password prompt mechanism
    // For now, throw — caller should check isE2eeConfigured() first
    throw new Error('E2EE key not in memory — call connectE2ee first');
  }
  return runFullSync(cachedKey);
}

export async function disconnectE2ee(): Promise<void> {
  cachedKey = null;
  const current = getAppState();
  await saveAppState({
    ...current,
    e2eeServerUrl: undefined,
    e2eeAuthToken: undefined,
    e2eeUserId: undefined,
    e2eeCollectionId: undefined,
    e2eeSalt: undefined,
    e2eeObjectMap: undefined,
    e2eeMaxVersion: undefined,
  });
}

// ── Pull ─────────────────────────────────────────────────────────────────

/**
 * Pull objects newer than `sinceVersion`. The caller is responsible for
 * computing `sinceVersion` from the *pre-push* state — passing the
 * post-push max would cause us to skip changes from peers whose
 * change_seq fell between our last sync and our just-completed push.
 */
async function pullE2ee(key: CryptoKey, sinceVersion: number): Promise<PullResult> {
  const { serverUrl, collectionId } = getE2eeConfig();
  const state = getAppState();
  const objectMap = { ...(state.e2eeObjectMap ?? {}) };
  const filenameByObjectId = new Map<string, string>();
  for (const [filename, entry] of Object.entries(objectMap)) {
    filenameByObjectId.set(entry.objectId, filename);
  }

  // Fetch changed objects since the caller-supplied version
  const data = await e2eeJson<{ objects: ServerObject[] }>(
    `${serverUrl}/api/collections/${collectionId}/objects?sinceVersion=${sinceVersion}`,
  );

  let newMaxVersion = Math.max(sinceVersion, state.e2eeMaxVersion ?? 0);
  const updates: Array<{ filename: string; content: string; hash: string; modified_at: number }> = [];
  const deletes: string[] = [];
  const updatedIds: string[] = [];
  const deletedIds: string[] = [];
  const hashToFilename = new Map<string, string>();
  const deletedHashes = new Map<string, string>();

  for (const obj of data.objects) {
    const version = Number(obj.version);
    const changeSeq = Number(obj.change_seq);
    if (changeSeq > newMaxVersion) newMaxVersion = changeSeq;

    if (obj.deleted) {
      const knownFilename = filenameByObjectId.get(obj.id);
      if (knownFilename) {
        const existing = objectMap[knownFilename];
        if (existing?.hash) deletedHashes.set(existing.hash, knownFilename);
        deletes.push(knownFilename);
        deletedIds.push(filenameToId(knownFilename));
        delete objectMap[knownFilename];
        filenameByObjectId.delete(obj.id);
      }
      continue;
    }

    if (!obj.blob_key) continue;

    // Skip objects we already have at this version (e.g. our own pushes
    // or earlier-pulled state). This avoids double-applying our writes
    // and keeps the watcher quiet for files we just pushed.
    const knownFilename = filenameByObjectId.get(obj.id);
    if (knownFilename) {
      const existing = objectMap[knownFilename];
      if (existing && existing.version >= version && existing.blobKey === obj.blob_key) {
        continue;
      }
    }

    let note: { filename: string; content: string };
    try {
      note = await downloadNoteByBlobKey(key, obj.blob_key);
    } catch (err) {
      console.warn(`[e2ee] Failed to download/decrypt blob ${obj.blob_key}:`, err);
      continue;
    }

    const { filename, content } = note;
    const hash = await sha256(content);

    // If a different filename was previously holding this objectId, the
    // remote renamed via in-place update — drop the stale map entry.
    if (knownFilename && knownFilename !== filename) {
      const existing = objectMap[knownFilename];
      if (existing?.hash) deletedHashes.set(existing.hash, knownFilename);
      delete objectMap[knownFilename];
      deletes.push(knownFilename);
      deletedIds.push(filenameToId(knownFilename));
    }

    updates.push({
      filename,
      content,
      hash,
      modified_at: new Date(obj.updated_at).getTime(),
    });
    updatedIds.push(filenameToId(filename));
    hashToFilename.set(hash, filename);

    objectMap[filename] = {
      objectId: obj.id,
      version,
      blobKey: obj.blob_key,
      hash,
      baseContent: content,
    };
    filenameByObjectId.set(obj.id, filename);
  }

  if (updates.length > 0 || deletes.length > 0) {
    await applySyncDeltaV2(updates, deletes, [], {});
  }

  const current = getAppState();
  await saveAppState({
    ...current,
    e2eeObjectMap: objectMap,
    e2eeMaxVersion: newMaxVersion,
  });
  return {
    downloaded: updates.length,
    deleted: deletes.length,
    updatedIds,
    deletedIds,
    newMaxVersion,
    hashToFilename,
    deletedHashes,
  };
}

// ── Push ─────────────────────────────────────────────────────────────────

async function resolveUpdateConflict(
  key: CryptoKey,
  filename: string,
  existing: E2eeObjectMapEntry,
  localContent: string,
  localHash: string,
  conflict: ConflictResponse,
  objectMap: E2eeObjectMap,
  localFilenames: Set<string>,
): Promise<{ uploaded: number; conflicts: number; maxVersion: number }> {
  if (!conflict.currentBlobKey) {
    console.warn(`[e2ee] Version conflict for ${filename} did not include a current blob key`);
    return { uploaded: 0, conflicts: 1, maxVersion: 0 };
  }

  const { serverUrl, collectionId } = getE2eeConfig();
  const remote = await downloadNoteByBlobKey(key, conflict.currentBlobKey);
  const remoteHash = await sha256(remote.content);
  let maxVersion = 0;

  let baseContent = existing.baseContent;
  if (baseContent === undefined && existing.blobKey) {
    try {
      baseContent = (await downloadNoteByBlobKey(key, existing.blobKey)).content;
    } catch (err) {
      console.warn(`[e2ee] Could not load merge base for ${filename}; falling back to conflict copy`, err);
    }
  }

  if (baseContent !== undefined) {
    const merge = threeWayMergeText(baseContent, remote.content, localContent);
    if (merge.clean) {
      const mergedHash = await sha256(merge.content);
      const uploaded = await uploadNoteBlob(key, filename, merge.content);
      const updateRes = await e2eeFetch(
        `${serverUrl}/api/collections/${collectionId}/objects/${existing.objectId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: conflict.currentVersion + 1,
            blob_key: uploaded.blobKey,
            size_bytes: uploaded.sizeBytes,
          }),
        },
      );

      if (updateRes.ok) {
        const updateData = await updateRes.json() as ObjectWriteResponse;
        const serverVersion = Number(updateData.object.version);
        maxVersion = Number(updateData.collectionVersion ?? updateData.object.change_seq ?? 0);
        await applySyncDeltaV2(
          [{ filename, content: merge.content, hash: mergedHash, modified_at: Date.now() }],
          [],
          [],
          {},
        );
        objectMap[filename] = {
          objectId: existing.objectId,
          version: serverVersion,
          blobKey: uploaded.blobKey,
          hash: mergedHash,
          baseContent: merge.content,
        };
        return { uploaded: 1, conflicts: 0, maxVersion };
      }

      console.warn(`[e2ee] Failed to upload merged conflict resolution for ${filename}: HTTP ${updateRes.status}`);
      return { uploaded: 0, conflicts: 1, maxVersion };
    }
  }

  const existingFilenames = new Set([...localFilenames, ...Object.keys(objectMap)]);
  const copyFilename = conflictFilename(filename, existingFilenames);
  const copyObject = await createObjectForNote(key, copyFilename, localContent);
  maxVersion = copyObject.changeSeq;

  await applySyncDeltaV2(
    [{ filename, content: remote.content, hash: remoteHash, modified_at: Date.now() }],
    [],
    [{ filename: copyFilename, content: localContent }],
    {},
  );

  objectMap[filename] = {
    objectId: existing.objectId,
    version: conflict.currentVersion,
    blobKey: conflict.currentBlobKey,
    hash: remoteHash,
    baseContent: remote.content,
  };
  objectMap[copyFilename] = {
    objectId: copyObject.objectId,
    version: copyObject.version,
    blobKey: copyObject.blobKey,
    hash: localHash,
    baseContent: localContent,
  };
  localFilenames.add(filename);
  localFilenames.add(copyFilename);

  return { uploaded: 1, conflicts: 1, maxVersion };
}

async function pushE2ee(key: CryptoKey): Promise<PushResult> {
  const { serverUrl, collectionId } = getE2eeConfig();
  const state = getAppState();
  const objectMap = { ...(state.e2eeObjectMap ?? {}) };
  let newMaxVersion = state.e2eeMaxVersion ?? 0;

  // List all local notes
  const fs = await getPlatformFS();
  const noteFiles = await fs.listNoteFiles();
  const localFilenames = new Set<string>();

  let uploaded = 0;
  let deleted = 0;
  let conflicts = 0;
  const updatedIds: string[] = [];
  const deletedIds: string[] = [];
  const deletedHashes = new Map<string, string>();

  for (const file of noteFiles) {
    const filename = file.name;
    if (!filename.endsWith('.md')) continue;
    localFilenames.add(filename);

    // Read content and compute hash
    const id = filenameToId(filename);
    let content: string;
    try {
      content = await fs.readNote(id);
    } catch {
      continue; // File may have been deleted between list and read
    }
    const existing = objectMap[filename];
    const hash = await sha256(content);

    if (existing?.hash === hash) {
      continue;
    }

    if (existing) {
      let uploadedBlob: { blobKey: string; sizeBytes: number };
      try {
        uploadedBlob = await uploadNoteBlob(key, filename, content);
      } catch (err) {
        console.warn(`[e2ee] Failed to upload blob for ${filename}:`, err);
        continue;
      }

      // Update existing object
      const nextVersion = existing.version + 1;
      const updateRes = await e2eeFetch(
        `${serverUrl}/api/collections/${collectionId}/objects/${existing.objectId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: nextVersion,
            blob_key: uploadedBlob.blobKey,
            size_bytes: uploadedBlob.sizeBytes,
          }),
        },
      );

      if (updateRes.ok) {
        const updateData = await updateRes.json() as ObjectWriteResponse;
        const serverVersion = Number(updateData.object.version);
        const changeSeq = Number(updateData.collectionVersion ?? updateData.object.change_seq ?? 0);
        if (changeSeq > newMaxVersion) newMaxVersion = changeSeq;
        objectMap[filename] = {
          objectId: existing.objectId,
          version: serverVersion,
          blobKey: uploadedBlob.blobKey,
          hash,
          baseContent: content,
        };
        uploaded++;
        updatedIds.push(id);
      } else if (updateRes.status === 409) {
        const conflictData = await updateRes.json().catch(() => null) as ConflictResponse | null;
        if (conflictData?.currentVersion !== undefined) {
          try {
            const resolution = await resolveUpdateConflict(
              key,
              filename,
              existing,
              content,
              hash,
              conflictData,
              objectMap,
              localFilenames,
            );
            uploaded += resolution.uploaded;
            conflicts += resolution.conflicts;
            if (resolution.maxVersion > newMaxVersion) newMaxVersion = resolution.maxVersion;
            if (resolution.uploaded > 0) updatedIds.push(id);
          } catch (err) {
            console.warn(`[e2ee] Failed to resolve version conflict for ${filename}:`, err);
            conflicts++;
          }
        } else {
          console.warn(`[e2ee] Version conflict for ${filename} had an invalid response`);
          conflicts++;
        }
      } else {
        console.warn(`[e2ee] Failed to update object for ${filename}: HTTP ${updateRes.status}`);
      }
    } else {
      try {
        const created = await createObjectForNote(key, filename, content);
        if (created.changeSeq > newMaxVersion) newMaxVersion = created.changeSeq;
        objectMap[filename] = {
          objectId: created.objectId,
          version: created.version,
          blobKey: created.blobKey,
          hash: created.hash,
          baseContent: content,
        };
        uploaded++;
        updatedIds.push(id);
      } catch (err) {
        console.warn(`[e2ee] Failed to create object for ${filename}:`, err);
      }
    }
  }

  // Handle local deletions: objects in the map but not on disk
  for (const [filename, entry] of Object.entries(objectMap)) {
    if (localFilenames.has(filename)) continue;

    const id = filenameToId(filename);
    const deleteRes = await e2eeFetch(
      `${serverUrl}/api/collections/${collectionId}/objects/${entry.objectId}?version=${entry.version}`,
      { method: 'DELETE' },
    );

    if (deleteRes.ok) {
      const deleteData = await deleteRes.json().catch(() => null) as ObjectWriteResponse | null;
      const changeSeq = Number(deleteData?.collectionVersion ?? deleteData?.object.change_seq ?? 0);
      if (changeSeq > newMaxVersion) newMaxVersion = changeSeq;
      delete objectMap[filename];
      deleted++;
      deletedIds.push(id);
      // Remember what we just deleted so the surrounding sync can match it
      // against a subsequent pull-add of the same content (rename detection).
      if (entry.hash) deletedHashes.set(entry.hash, filename);
      continue;
    }

    if (deleteRes.status === 409) {
      const conflictData = await deleteRes.json().catch(() => null) as ConflictResponse | null;
      if (!conflictData || !conflictData.currentBlobKey) {
        console.warn(`[e2ee] Delete conflict for ${filename} had no current blob`);
        conflicts++;
        continue;
      }
      try {
        // Edit-wins: a peer updated the note while we were trying to delete
        // it. Restore the latest content locally so the user keeps the edit.
        const restored = await downloadNoteByBlobKey(key, conflictData.currentBlobKey);
        const restoredHash = await sha256(restored.content);
        await applySyncDeltaV2(
          [{
            filename: restored.filename,
            content: restored.content,
            hash: restoredHash,
            modified_at: Date.now(),
          }],
          [],
          [],
          {},
        );
        objectMap[restored.filename] = {
          objectId: entry.objectId,
          version: conflictData.currentVersion,
          blobKey: conflictData.currentBlobKey,
          hash: restoredHash,
          baseContent: restored.content,
        };
        // Drop the stale entry if the remote rename moved the file.
        if (restored.filename !== filename) delete objectMap[filename];
        localFilenames.add(restored.filename);
        updatedIds.push(filenameToId(restored.filename));
      } catch (err) {
        console.warn(`[e2ee] Failed to restore deleted-vs-edit conflict for ${filename}:`, err);
        conflicts++;
      }
      continue;
    }

    console.warn(`[e2ee] Failed to delete object for ${filename}: HTTP ${deleteRes.status}`);
  }

  // Persist updated object map
  const current = getAppState();
  await saveAppState({
    ...current,
    e2eeObjectMap: objectMap,
    e2eeMaxVersion: newMaxVersion,
  });

  console.log(`[e2ee] Push: ${uploaded} uploaded, ${deleted} deleted, ${conflicts} conflicts`);
  return {
    uploaded,
    deleted,
    conflicts,
    updatedIds,
    deletedIds,
    newMaxVersion,
    deletedHashes,
  };
}

// ── Full sync ────────────────────────────────────────────────────────────

export async function syncE2ee(password: string): Promise<SyncSummary> {
  const state = getAppState();
  if (!state.e2eeCollectionId) throw new Error('E2EE not configured — call connectE2ee first');

  const key = await unlockConfiguredVaultKey(password);
  cachedKey = key;

  return runFullSync(key);
}

/**
 * Run a single push+pull cycle and reconcile the results into a `SyncSummary`.
 *
 * Pull's `sinceVersion` is captured BEFORE push so that peer changes whose
 * `change_seq` falls between our last sync and our just-completed push are
 * not skipped. (Push advances `e2eeMaxVersion` for our own writes; pulling
 * from that newer baseline would miss any peer changes with a smaller seq.)
 *
 * Renames are reconstructed by hash-matching files this push deleted against
 * files this pull added — since each E2EE blob is encrypted independently,
 * a rename surfaces on the wire as a delete + create with identical bodies.
 */
async function runFullSync(key: CryptoKey): Promise<SyncSummary> {
  const prePushMaxVersion = getAppState().e2eeMaxVersion ?? 0;

  // Push first so local stale edits can hit the server's version check and
  // resolve against the common ancestor before pull applies remote content.
  const pushResult = await pushE2ee(key);
  const pullResult = await pullE2ee(key, prePushMaxVersion);

  const renamed: Array<{ fromId: string; toId: string }> = [];
  const renamedFromIds = new Set<string>();
  const renamedToIds = new Set<string>();

  // Combine push-deleted + pull-deleted hashes so we detect renames whether
  // the rename happened on this client (push deletes a stale entry) or on
  // a peer (pull surfaces a tombstone next to a freshly-added blob with the
  // same body). E2EE makes blobs opaque, so the only signal of "same note,
  // new name" is content equality.
  const allDeletedHashes = new Map<string, string>();
  for (const [hash, fromFilename] of pushResult.deletedHashes) {
    allDeletedHashes.set(hash, fromFilename);
  }
  for (const [hash, fromFilename] of pullResult.deletedHashes) {
    if (!allDeletedHashes.has(hash)) allDeletedHashes.set(hash, fromFilename);
  }
  for (const [hash, fromFilename] of allDeletedHashes) {
    const toFilename = pullResult.hashToFilename.get(hash);
    if (!toFilename || toFilename === fromFilename) continue;
    const fromId = filenameToId(fromFilename);
    const toId = filenameToId(toFilename);
    renamed.push({ fromId, toId });
    renamedFromIds.add(fromId);
    renamedToIds.add(toId);
  }

  const seenUpdated = new Set<string>();
  const updatedIds: string[] = [];
  for (const id of [...pushResult.updatedIds, ...pullResult.updatedIds]) {
    if (renamedToIds.has(id) || renamedFromIds.has(id)) continue;
    if (seenUpdated.has(id)) continue;
    seenUpdated.add(id);
    updatedIds.push(id);
  }

  const seenDeleted = new Set<string>();
  const deletedIds: string[] = [];
  for (const id of [...pushResult.deletedIds, ...pullResult.deletedIds]) {
    if (renamedFromIds.has(id) || renamedToIds.has(id)) continue;
    if (seenDeleted.has(id)) continue;
    seenDeleted.add(id);
    deletedIds.push(id);
  }

  const current = getAppState();
  await saveAppState({
    ...current,
    lastSyncedAt: Date.now(),
    lastSyncError: '',
  });

  return {
    uploaded: pushResult.uploaded,
    downloaded: pullResult.downloaded,
    deleted: pullResult.deleted + pushResult.deleted,
    conflicts: pushResult.conflicts,
    updatedIds,
    deletedIds,
    renamed,
  };
}
