// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ platformName: 'tauri' }));
vi.mock('$features/system/crashHandler', () => ({ getAppVersion: () => '1.2.3' }));

const { submitFeedback } = await import('./submitFeedback');

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

  // The field names are the server schema, and the key list is the privacy
  // rule: nothing derived from the vault or the open note (no route, no session
  // id, no path) rides along with what the user typed.
  it('posts only the fields the server schema expects', async () => {
    await submitFeedback({ message: 'it broke', images: [] });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5100/api/feedback');
    expect(init.method).toBe('POST');
    expect(sentBody()).toEqual({
      message: 'it broke',
      app_version: '1.2.3',
      platform: 'tauri',
      device_info: expect.any(String),
      images: [],
    });
  });

  it('base64-encodes each image under a data key, bytes that are not text included', async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]).buffer;
    await submitFeedback({ message: 'shot', images: [bytes] });

    expect(sentBody().images).toEqual([{ data: 'AP+JUE5H' }]);
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
