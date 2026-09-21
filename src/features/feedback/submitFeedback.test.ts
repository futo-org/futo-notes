// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ platformName: 'tauri' }));
vi.mock('$features/system/crashHandler', () => ({ getAppVersion: () => '1.2.3' }));

const { submitFeedback, toBase64 } = await import('./submitFeedback');

const fetchMock = vi.fn();

function sentBody(): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
}

describe('submitFeedback', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('follows the dev staging toggle to the staging host', async () => {
    window.localStorage.setItem('futo_crashlog_staging', 'true');
    try {
      await submitFeedback({ message: 'it broke', images: [] });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://staging-notes-crashlog.futo.org/api/feedback',
      );
    } finally {
      window.localStorage.clear();
    }
  });

  it('posts the field names the server schema expects', async () => {
    await submitFeedback({ message: 'it broke', images: [] });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5100/api/feedback');
    expect(init.method).toBe('POST');
    expect(sentBody()).toMatchObject({
      message: 'it broke',
      app_version: '1.2.3',
      platform: 'tauri',
    });
  });

  it('sends nothing derived from the vault or the open note', async () => {
    await submitFeedback({ message: 'hi', images: [] });

    const body = sentBody();
    expect(body).not.toHaveProperty('route');
    expect(body).not.toHaveProperty('session_id');
    expect(Object.keys(body).sort()).toEqual([
      'app_version',
      'device_info',
      'images',
      'message',
      'platform',
    ]);
  });

  it('base64-encodes each image under a data key', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    await submitFeedback({ message: 'shot', images: [png] });

    expect(sentBody().images).toEqual([{ data: 'iVBORw==' }]);
  });

  it('reports the status when the server refuses', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('message is empty'),
    });

    await expect(submitFeedback({ message: ' ', images: [] })).rejects.toThrow(
      'HTTP 400: message is empty',
    );
  });

  it('lets a network failure reach the caller', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    await expect(submitFeedback({ message: 'x', images: [] })).rejects.toThrow('offline');
  });
});

describe('toBase64', () => {
  it('round-trips bytes that are not valid text', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    const decoded = Uint8Array.from(atob(toBase64(bytes.buffer)), (c) => c.charCodeAt(0));

    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('encodes an empty buffer as an empty string', () => {
    expect(toBase64(new ArrayBuffer(0))).toBe('');
  });
});
