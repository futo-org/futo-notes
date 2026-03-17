import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, req, type TestEnv } from '../helpers/setup.js';
import { contentHash } from '../../src/sync/hash.js';

/** Helper to manage reading SSE chunks from a single reader. */
function createSSEReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    /** Read until predicate matches or timeout. */
    async readUntil(predicate: (buf: string) => boolean, timeoutMs = 2000): Promise<string> {
      if (predicate(buffer)) return buffer;

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SSE read timed out')), timeoutMs),
      );

      const read = async (): Promise<string> => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (predicate(buffer)) return buffer;
        }
        return buffer;
      };

      return Promise.race([read(), timeout]);
    },

    /** Try to read for a duration, returning whatever arrives. */
    async readFor(ms: number): Promise<string> {
      const startLen = buffer.length;
      const readOne = async () => {
        const { value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
      };

      await Promise.race([readOne(), new Promise<void>((r) => setTimeout(r, ms))]);
      return buffer.slice(startLen);
    },

    cancel() {
      reader.cancel();
    },

    get contents() {
      return buffer;
    },
  };
}

async function createSseTicket(app: TestEnv['app'], token: string): Promise<string> {
  const res = await app.request('/events/session', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  expect(res.status).toBe(200);
  const data = await res.json() as { ticket: string };
  return data.ticket;
}

describe('GET /events (SSE)', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('rejects request without ticket (401)', async () => {
    const res = await req(env.app, 'GET', '/events?clientId=c1');
    expect(res.status).toBe(401);
  });

  it('rejects request with bad ticket (401)', async () => {
    const res = await req(env.app, 'GET', '/events?ticket=badticket&clientId=c1');
    expect(res.status).toBe(401);
  });

  it('rejects request without clientId (401)', async () => {
    const ticket = await createSseTicket(env.app, token);
    const res = await req(env.app, 'GET', `/events?ticket=${ticket}`);
    expect(res.status).toBe(401);
  });

  it('successful connection sends connected event', async () => {
    const ticket = await createSseTicket(env.app, token);
    const res = await env.app.request(`/events?ticket=${ticket}&clientId=c1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const sse = createSSEReader(res);
    try {
      await sse.readUntil((buf) => buf.includes('event: connected'));
      expect(sse.contents).toContain('event: connected');
    } finally {
      sse.cancel();
    }
  });

  it('broadcasts sync_available to other clients after sync', async () => {
    // Client A connects SSE
    const ticket = await createSseTicket(env.app, token);
    const sseRes = await env.app.request(`/events?ticket=${ticket}&clientId=clientA`);
    expect(sseRes.status).toBe(200);

    const sse = createSSEReader(sseRes);
    try {
      // Wait for connected event first
      await sse.readUntil((buf) => buf.includes('event: connected'));

      // Client B syncs a new note
      const content = '# New note from B';
      const hash = contentHash(content);
      const syncRes = await env.app.request('/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Client-Id': 'clientB',
        },
        body: JSON.stringify({
          notes: [{
            uuid: 'u1',
            filename: 'test.md',
            modified_at: Date.now(),
            content_hash: hash,
            hash_at_last_sync: '',
            content,
          }],
          inventory: [{ uuid: 'u1', content_hash: hash, filename: 'test.md', modified_at: Date.now() }],
          deleted_uuids: [],
        }),
      });
      expect(syncRes.status).toBe(200);

      // Client A should receive sync_available
      await sse.readUntil((buf) => buf.includes('event: sync_available'));
      expect(sse.contents).toContain('event: sync_available');
    } finally {
      sse.cancel();
    }
  });

  it('excludes the syncing client from broadcast', async () => {
    // Client A connects SSE with clientId=clientA
    const ticket = await createSseTicket(env.app, token);
    const sseRes = await env.app.request(`/events?ticket=${ticket}&clientId=clientA`);
    const sse = createSSEReader(sseRes);

    try {
      await sse.readUntil((buf) => buf.includes('event: connected'));

      // Client A syncs with X-Client-Id: clientA — should NOT receive broadcast
      const content = '# Self sync';
      const hash = contentHash(content);
      await env.app.request('/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Client-Id': 'clientA',
        },
        body: JSON.stringify({
          notes: [{
            uuid: 'u1',
            filename: 'test.md',
            modified_at: Date.now(),
            content_hash: hash,
            hash_at_last_sync: '',
            content,
          }],
          inventory: [{ uuid: 'u1', content_hash: hash, filename: 'test.md', modified_at: Date.now() }],
          deleted_uuids: [],
        }),
      });

      // Wait a bit and read whatever arrives
      const newData = await sse.readFor(300);
      expect(newData).not.toContain('event: sync_available');
    } finally {
      sse.cancel();
    }
  });

  it('does not broadcast when a client only downloads server updates', async () => {
    const ticket = await createSseTicket(env.app, token);
    const observerRes = await env.app.request(`/events?ticket=${ticket}&clientId=observer`);
    const observer = createSSEReader(observerRes);

    try {
      await observer.readUntil((buf) => buf.includes('event: connected'));

      const content = '# Seed note';
      const hash = contentHash(content);
      const uploadRes = await env.app.request('/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Client-Id': 'uploader',
        },
        body: JSON.stringify({
          notes: [{
            uuid: 'u-seed',
            filename: 'seed.md',
            modified_at: Date.now(),
            content_hash: hash,
            hash_at_last_sync: '',
            content,
          }],
          inventory: [{ uuid: 'u-seed', content_hash: hash, filename: 'seed.md', modified_at: Date.now() }],
          deleted_uuids: [],
        }),
      });
      expect(uploadRes.status).toBe(200);

      // Drain the expected broadcast from uploader mutation.
      await observer.readUntil((buf) => buf.includes('event: sync_available'));

      const before = observer.contents.length;

      // Downloader has no local notes, so server will return update-only.
      const downloadRes = await env.app.request('/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Client-Id': 'downloader',
        },
        body: JSON.stringify({
          notes: [],
          inventory: [],
          deleted_uuids: [],
        }),
      });
      expect(downloadRes.status).toBe(200);

      const payload = await downloadRes.json() as {
        update: Array<{ uuid: string }>;
        delete: string[];
        hash_updates: Array<{ uuid: string }>;
      };
      expect(payload.update.length).toBeGreaterThan(0);
      expect(payload.hash_updates).toHaveLength(0);
      expect(payload.delete).toHaveLength(0);

      const newData = await observer.readFor(300);
      expect(observer.contents.length).toBe(before);
      expect(newData).not.toContain('event: sync_available');
    } finally {
      observer.cancel();
    }
  });
});
