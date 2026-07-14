// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWriteAppData = vi.fn<(path: string, content: string) => Promise<void>>();

const platformState = { hasFileSystem: true };

const storage = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

vi.mock('$lib/platform', () => ({
  get hasFileSystem() {
    return platformState.hasFileSystem;
  },
  getFS: () => ({
    writeAppData: mockWriteAppData,
    listAppData: vi.fn().mockResolvedValue([]),
    readAppData: vi.fn().mockResolvedValue(null),
    deleteAppData: vi.fn().mockResolvedValue(undefined),
    getPlatformName: vi.fn().mockReturnValue('web'),
    getAppVersion: vi.fn().mockResolvedValue('0.0.0-test'),
  }),
}));

const LS_QUEUE_KEY = 'futo_crash_queue';

function makeCrashReport(error: string) {
  return {
    error,
    stack: 'at test:1:1',
    app_version: '0.0.0',
    platform: 'web',
    device_info: 'test',
    timestamp: new Date().toISOString(),
    type: 'js_error' as const,
    route: '/',
    session_id: 'test-session',
  };
}

describe('flushCrashQueue', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockWriteAppData.mockReset();
    mockWriteAppData.mockResolvedValue(undefined);
    platformState.hasFileSystem = true;
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('writes all queued reports and clears localStorage', async () => {
    vi.resetModules();
    const { flushCrashQueue } = await import('./crashHandler');

    const reports = [makeCrashReport('error1'), makeCrashReport('error2')];
    window.localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(reports));

    await flushCrashQueue();

    expect(mockWriteAppData).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(LS_QUEUE_KEY)).toBeNull();
  });

  it('preserves unwritten entries on partial write failure', async () => {
    vi.resetModules();
    const { flushCrashQueue } = await import('./crashHandler');

    const reports = [
      makeCrashReport('error1'),
      makeCrashReport('error2'),
      makeCrashReport('error3'),
    ];
    window.localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(reports));

    mockWriteAppData
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);

    await flushCrashQueue();

    // The failed report should remain in localStorage
    const remaining = JSON.parse(window.localStorage.getItem(LS_QUEUE_KEY)!);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].error).toBe('error2');
  });

  it('clears localStorage when no filesystem is available', async () => {
    platformState.hasFileSystem = false;
    vi.resetModules();
    const { flushCrashQueue } = await import('./crashHandler');

    const reports = [makeCrashReport('error1')];
    window.localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(reports));

    await flushCrashQueue();

    expect(window.localStorage.getItem(LS_QUEUE_KEY)).toBeNull();
  });
});

describe('installGlobalHandlers', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockWriteAppData.mockReset();
    mockWriteAppData.mockResolvedValue(undefined);
    platformState.hasFileSystem = true;
  });

  afterEach(() => {
    window.localStorage.clear();
    window.onerror = null;
    window.onunhandledrejection = null;
  });

  it('attempts immediate writeAppData on onerror', async () => {
    vi.resetModules();
    const { installGlobalHandlers } = await import('./crashHandler');
    installGlobalHandlers();

    window.onerror!('Test error', 'test.js', 1, 1, new Error('Test error'));

    // Should queue to localStorage
    const queued = JSON.parse(window.localStorage.getItem(LS_QUEUE_KEY)!);
    expect(queued).toHaveLength(1);
    expect(queued[0].error).toBe('Test error');

    expect(mockWriteAppData).toHaveBeenCalledTimes(1);
    expect(mockWriteAppData.mock.calls[0][0]).toMatch(/^\.crashlogs\/crash-/);
  });

  it('attempts immediate writeAppData on unhandledrejection', async () => {
    vi.resetModules();
    const { installGlobalHandlers } = await import('./crashHandler');
    installGlobalHandlers();

    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: new Error('Promise failed') });
    window.onunhandledrejection!(event);

    // Should queue to localStorage
    const queued = JSON.parse(window.localStorage.getItem(LS_QUEUE_KEY)!);
    expect(queued).toHaveLength(1);
    expect(queued[0].error).toBe('Promise failed');

    expect(mockWriteAppData).toHaveBeenCalledTimes(1);
  });

  it('still queues to localStorage when immediate write fails', async () => {
    mockWriteAppData.mockRejectedValue(new Error('FS not ready'));
    vi.resetModules();
    const { installGlobalHandlers } = await import('./crashHandler');
    installGlobalHandlers();

    window.onerror!('Crash', 'test.js', 1, 1, new Error('Crash'));

    // localStorage should still have the report
    const queued = JSON.parse(window.localStorage.getItem(LS_QUEUE_KEY)!);
    expect(queued).toHaveLength(1);
    expect(queued[0].error).toBe('Crash');
  });
});
