// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./appState', () => ({
  getCachedPreferences: vi.fn(),
}));

import { getCachedPreferences } from './appState';
import { authFetch, AuthFetchError, getSyncConfig } from './authFetch';

const mockGetCachedPreferences = vi.mocked(getCachedPreferences);

function mockPrefs(serverUrl = 'https://sync.example.com', token = 'test-token') {
  mockGetCachedPreferences.mockReturnValue({
    appearance: { theme: 'auto' },
    crashReporting: { enabled: false, alwaysSend: false },
    sync: { serverUrl, token, lastSyncedAt: null, lastError: '' },
  });
}

describe('getSyncConfig', () => {
  beforeEach(() => mockPrefs());

  it('returns serverUrl and token from cached preferences', () => {
    const config = getSyncConfig();
    expect(config).toEqual({ serverUrl: 'https://sync.example.com', token: 'test-token' });
  });
});

describe('authFetch', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPrefs();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends GET request with Bearer header by default', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await authFetch<{ ok: boolean }>('/test/endpoint');

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://sync.example.com/test/endpoint');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-token',
    });
  });

  it('sends POST request with JSON body', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 200 }));

    const result = await authFetch<{ id: number }>('/items', {
      method: 'POST',
      body: { name: 'test' },
    });

    expect(result).toEqual({ id: 1 });
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    });
    expect(init.body).toBe(JSON.stringify({ name: 'test' }));
  });

  it('merges custom headers', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await authFetch('/test', { headers: { 'X-Custom': 'value' } });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'X-Custom': 'value',
    });
  });

  it('throws AuthFetchError on non-ok response with error body', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not authorized' }), { status: 401 }),
    );

    try {
      await authFetch('/protected');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthFetchError);
      const err = e as AuthFetchError;
      expect(err.status).toBe(401);
      expect(err.serverMessage).toBe('Not authorized');
      expect(err.message).toBe('Not authorized');
    }
  });

  it('throws AuthFetchError with fallback message when response has no error field', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'something' }), { status: 500 }),
    );

    try {
      await authFetch('/fail');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthFetchError);
      const err = e as AuthFetchError;
      expect(err.status).toBe(500);
      expect(err.message).toBe('HTTP 500');
      expect(err.serverMessage).toBeUndefined();
    }
  });

  it('throws AuthFetchError when response body is not JSON', async () => {
    fetchSpy.mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    try {
      await authFetch('/fail');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthFetchError);
      const err = e as AuthFetchError;
      expect(err.status).toBe(500);
      expect(err.message).toBe('HTTP 500');
    }
  });

  it('returns raw Response when raw: true', async () => {
    const body = JSON.stringify({ data: 'raw' });
    fetchSpy.mockResolvedValue(new Response(body, { status: 200 }));

    const res = await authFetch('/raw', { raw: true });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ data: 'raw' });
  });

  it('returns raw Response even on non-ok when raw: true', async () => {
    fetchSpy.mockResolvedValue(new Response('error', { status: 403 }));

    const res = await authFetch('/raw-fail', { raw: true });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
  });

  it('applies timeout via AbortController', async () => {
    vi.useFakeTimers();

    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const promise = authFetch('/slow');
    vi.advanceTimersByTime(10_000);

    await expect(promise).rejects.toThrow('aborted');

    vi.useRealTimers();
  });

  it('composes caller signal with timeout signal', async () => {
    const callerController = new AbortController();

    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const promise = authFetch('/slow', { signal: callerController.signal });
    callerController.abort();

    await expect(promise).rejects.toThrow('aborted');
  });
});
