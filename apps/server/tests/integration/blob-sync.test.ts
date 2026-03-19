import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, authReq, type TestEnv } from '../helpers/setup.js';
import { binaryContentHash } from '../../src/sync/hash.js';
import { readBlobFile } from '../../src/sync/files.js';
import crypto from 'node:crypto';

/** Helper to upload a blob via PUT /sync/blob/:uuid */
async function uploadBlob(
  env: TestEnv,
  token: string,
  uuid: string,
  filename: string,
  data: Buffer,
  modifiedAt?: number,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    Authorization: `Bearer ${token}`,
    'X-Filename': filename,
  };
  if (modifiedAt !== undefined) {
    headers['X-Modified-At'] = String(modifiedAt);
  }
  return env.app.request(`/sync/blob/${uuid}`, {
    method: 'PUT',
    headers,
    body: new Uint8Array(data) as unknown as BodyInit,
  });
}

/** Helper to download a blob via GET /sync/blob/:uuid */
async function downloadBlob(env: TestEnv, token: string, uuid: string): Promise<Response> {
  return env.app.request(`/sync/blob/${uuid}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('Blob sync', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  describe('PUT /sync/blob/:uuid', () => {
    it('uploads an image file', async () => {
      const data = Buffer.from('fake jpeg data');
      const res = await uploadBlob(env, token, 'img-1', '1234-abc.jpg', data, Date.now());
      expect(res.status).toBe(200);
      const body = await res.json() as { uuid: string; content_hash: string; filename: string };
      expect(body.uuid).toBe('img-1');
      expect(body.content_hash).toBe(binaryContentHash(data));
      expect(body.filename).toBe('1234-abc.jpg');
    });

    it('rejects missing X-Filename header', async () => {
      const res = await env.app.request('/sync/blob/img-1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${token}`,
        },
        body: new Uint8Array(Buffer.from('data')) as unknown as BodyInit,
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid image extension', async () => {
      const data = Buffer.from('not an image');
      const res = await uploadBlob(env, token, 'img-bad', 'script.exe', data);
      expect(res.status).toBe(400);
    });

    it('rejects unauthorized request', async () => {
      const res = await env.app.request('/sync/blob/img-1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': 'test.jpg',
        },
        body: new Uint8Array(Buffer.from('data')) as unknown as BodyInit,
      });
      expect(res.status).toBe(401);
    });

    it('rejects empty file', async () => {
      const res = await uploadBlob(env, token, 'img-empty', 'empty.jpg', Buffer.alloc(0));
      expect(res.status).toBe(400);
    });

    it('writes file to disk', async () => {
      const data = Buffer.from('image content here');
      await uploadBlob(env, token, 'img-disk', '5678-def.png', data, Date.now());
      const onDisk = readBlobFile(env.notesDir, '5678-def.png');
      expect(onDisk).not.toBeNull();
      expect(onDisk!.equals(data)).toBe(true);
    });
  });

  describe('GET /sync/blob/:uuid', () => {
    it('returns 404 for unknown UUID', async () => {
      const res = await downloadBlob(env, token, 'nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await env.app.request('/sync/blob/img-1', {
        method: 'GET',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Full image sync round-trip', () => {
    it('upload → sync → download on another client', async () => {
      const imageData = Buffer.from('JPEG image binary content');
      const imageHash = binaryContentHash(imageData);
      const now = Date.now();
      const filename = '1700000000000-abc.jpg';

      // Step 1: Client A uploads the blob
      const uploadRes = await uploadBlob(env, token, 'img-uuid-1', filename, imageData, now);
      expect(uploadRes.status).toBe(200);

      // Step 2: Client A syncs (registers the image in the DB)
      const syncA = await authReq(env.app, 'POST', '/sync', token, {
        notes: [{
          uuid: 'img-uuid-1',
          filename,
          modified_at: now,
          content_hash: imageHash,
          hash_at_last_sync: '',
          is_blob: true,
        }],
        inventory: [{
          uuid: 'img-uuid-1',
          content_hash: imageHash,
          filename,
          modified_at: now,
        }],
        deleted_uuids: [],
      });
      expect(syncA.status).toBe(200);
      const syncAData = await syncA.json();
      expect(syncAData.hash_updates).toHaveLength(1);
      expect(syncAData.hash_updates[0].uuid).toBe('img-uuid-1');

      // Step 3: Client B syncs (should receive the image metadata)
      const syncB = await authReq(env.app, 'POST', '/sync', token, {
        notes: [],
        inventory: [],
        deleted_uuids: [],
      });
      expect(syncB.status).toBe(200);
      const syncBData = await syncB.json();
      const blobUpdate = syncBData.update.find((u: { uuid: string }) => u.uuid === 'img-uuid-1');
      expect(blobUpdate).toBeDefined();
      expect(blobUpdate.is_blob).toBe(true);
      expect(blobUpdate.filename).toBe(filename);
      expect(blobUpdate.content_hash).toBe(imageHash);
      // Blob updates should NOT include content
      expect(blobUpdate.content).toBeUndefined();

      // Step 4: Client B downloads the actual blob
      const blobRes = await downloadBlob(env, token, 'img-uuid-1');
      expect(blobRes.status).toBe(200);
      const downloadedData = Buffer.from(await blobRes.arrayBuffer());
      expect(downloadedData.equals(imageData)).toBe(true);
    });

    it('image deletion propagates via tombstone', async () => {
      const imageData = Buffer.from('deletable image');
      const imageHash = binaryContentHash(imageData);
      const now = Date.now();
      const filename = '1700000000001-del.jpg';

      // Upload and sync
      await uploadBlob(env, token, 'img-del-1', filename, imageData, now);
      await authReq(env.app, 'POST', '/sync', token, {
        notes: [{
          uuid: 'img-del-1',
          filename,
          modified_at: now,
          content_hash: imageHash,
          hash_at_last_sync: '',
          is_blob: true,
        }],
        inventory: [{ uuid: 'img-del-1', content_hash: imageHash, filename, modified_at: now }],
        deleted_uuids: [],
      });

      // Client A deletes the image
      const deleteSync = await authReq(env.app, 'POST', '/sync', token, {
        notes: [],
        inventory: [],
        deleted_uuids: ['img-del-1'],
      });
      expect(deleteSync.status).toBe(200);

      // Client B should be told to delete
      const syncB = await authReq(env.app, 'POST', '/sync', token, {
        notes: [],
        inventory: [{ uuid: 'img-del-1', content_hash: imageHash, filename, modified_at: now }],
        deleted_uuids: [],
      });
      expect(syncB.status).toBe(200);
      const syncBData = await syncB.json();
      expect(syncBData.delete).toContain('img-del-1');
    });

    it('mixed notes and images in same sync', async () => {
      const imageData = Buffer.from('mixed sync image');
      const imageHash = binaryContentHash(imageData);
      const noteContent = '# Note with image\n![](1700000000002-mix.png)';
      const noteHash = crypto.createHash('sha256').update(noteContent, 'utf8').digest('hex');
      const now = Date.now();

      // Upload image blob
      await uploadBlob(env, token, 'img-mix', '1700000000002-mix.png', imageData, now);

      // Sync both note and image together
      const syncRes = await authReq(env.app, 'POST', '/sync', token, {
        notes: [
          {
            uuid: 'note-mix',
            filename: 'note with image.md',
            modified_at: now,
            content_hash: noteHash,
            hash_at_last_sync: '',
            content: noteContent,
          },
          {
            uuid: 'img-mix',
            filename: '1700000000002-mix.png',
            modified_at: now,
            content_hash: imageHash,
            hash_at_last_sync: '',
            is_blob: true,
          },
        ],
        inventory: [
          { uuid: 'note-mix', content_hash: noteHash, filename: 'note with image.md', modified_at: now },
          { uuid: 'img-mix', content_hash: imageHash, filename: '1700000000002-mix.png', modified_at: now },
        ],
        deleted_uuids: [],
      });
      expect(syncRes.status).toBe(200);
      const data = await syncRes.json();
      expect(data.hash_updates).toHaveLength(2);

      // Another client should receive both
      const syncB = await authReq(env.app, 'POST', '/sync', token, {
        notes: [],
        inventory: [],
        deleted_uuids: [],
      });
      const syncBData = await syncB.json();
      expect(syncBData.update.length).toBe(2);

      const noteUpdate = syncBData.update.find((u: { uuid: string }) => u.uuid === 'note-mix');
      const imgUpdate = syncBData.update.find((u: { uuid: string }) => u.uuid === 'img-mix');
      expect(noteUpdate.content).toBe(noteContent);
      expect(noteUpdate.is_blob).toBeUndefined();
      expect(imgUpdate.is_blob).toBe(true);
      expect(imgUpdate.content).toBeUndefined();
    });
  });

  describe('Multi-client image sync', () => {
    it('image uploaded by client A is available to client B', async () => {
      const imageData = Buffer.from('multi-client image test');
      const imageHash = binaryContentHash(imageData);
      const now = Date.now();
      const filename = '1700000000003-multi.jpg';

      // Client A uploads and syncs
      await uploadBlob(env, token, 'img-multi', filename, imageData, now);
      const syncA = await authReq(env.app, 'POST', '/sync', token, {
        notes: [{
          uuid: 'img-multi',
          filename,
          modified_at: now,
          content_hash: imageHash,
          hash_at_last_sync: '',
          is_blob: true,
        }],
        inventory: [{ uuid: 'img-multi', content_hash: imageHash, filename, modified_at: now }],
        deleted_uuids: [],
      });
      expect(syncA.status).toBe(200);

      // Client B syncs and sees the image
      const syncB = await authReq(env.app, 'POST', '/sync', token, {
        notes: [],
        inventory: [],
        deleted_uuids: [],
      });
      const syncBData = await syncB.json();
      const imgUpdate = syncBData.update.find((u: { uuid: string }) => u.uuid === 'img-multi');
      expect(imgUpdate).toBeDefined();
      expect(imgUpdate.is_blob).toBe(true);

      // Client B can download
      const blobRes = await downloadBlob(env, token, 'img-multi');
      expect(blobRes.status).toBe(200);
      const downloaded = Buffer.from(await blobRes.arrayBuffer());
      expect(downloaded.equals(imageData)).toBe(true);

      // Client B syncs again with image in inventory — no re-download
      const syncB2 = await authReq(env.app, 'POST', '/sync', token, {
        notes: [],
        inventory: [{ uuid: 'img-multi', content_hash: imageHash, filename, modified_at: now }],
        deleted_uuids: [],
      });
      const syncB2Data = await syncB2.json();
      const imgUpdate2 = syncB2Data.update.find((u: { uuid: string }) => u.uuid === 'img-multi');
      expect(imgUpdate2).toBeUndefined();
    });
  });
});
