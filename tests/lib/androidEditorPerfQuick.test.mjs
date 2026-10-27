import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  listen: vi.fn((_port, _host, ready) => ready()),
  adb: vi.fn(),
  shell: vi.fn((command) => {
    if (command.includes('android.intent.action.VIEW')) throw harness.stop;
    return '';
  }),
  stop: new Error('stop before touching a device'),
}));
vi.mock('node:http', () => ({
  createServer: () => ({
    listen: harness.listen,
    once: vi.fn(),
    address: () => ({ port: 43123 }),
    close: vi.fn(),
    closeAllConnections: vi.fn(),
  }),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original()),
  existsSync: () => true,
}));
vi.mock('./android/adbClient.mjs', () => ({
  createAdbClient: () => ({ adb: harness.adb, shell: harness.shell }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Android quick perf server', () => {
  it('allocates an independent port even when desktop port environment is present', async () => {
    vi.stubEnv('ANDROID_SERIAL', 'fixture-only');
    vi.stubEnv('WEB_VITE_PORT', '5297');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => [] })),
    );
    const argv = process.argv;
    process.argv = ['node', 'android-editor-perf-quick.mjs', '--no-build'];
    try {
      await expect(import('../android-editor-perf-quick.mjs')).rejects.toBe(harness.stop);
      expect(harness.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
      expect(harness.adb).toHaveBeenCalledWith(['reverse', 'tcp:43123', 'tcp:43123']);
      const navigation = harness.shell.mock.calls.find(([command]) =>
        command.includes('android.intent.action.VIEW'),
      )[0];
      const url = new URL(navigation.match(/-d '([^']+)'/)[1]);
      expect(url.port).toBe('43123');
      expect(url.searchParams.has('test')).toBe(true);
    } finally {
      process.argv = argv;
    }
  });
});
