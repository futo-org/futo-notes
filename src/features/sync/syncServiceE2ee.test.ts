import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve({ token: 't', userId: 'u', collectionId: 'c' })),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('$shared/state/appState', () => ({
  getAppState: vi.fn(() => ({})),
  saveAppState: vi.fn(() => Promise.resolve()),
}));

import { invoke } from '@tauri-apps/api/core';
import { saveAppState } from '$shared/state/appState';
import { validateSyncServerUrl, connectE2ee } from './syncServiceE2ee';

const mockInvoke = vi.mocked(invoke);
const mockSaveAppState = vi.mocked(saveAppState);

const serverUrlFixture = JSON.parse(
  readFileSync(new URL('../../../tests/conformance/server-url.json', import.meta.url), 'utf8'),
) as { op: string; cases: { input: string; expected: string | null }[] };

describe('validateSyncServerUrl — conformance fixture (tests/conformance/server-url.json)', () => {
  for (const c of serverUrlFixture.cases) {
    const verb = c.expected === null ? 'accepts' : 'rejects';
    it(`${verb} ${JSON.stringify(c.input)}`, () => {
      expect(validateSyncServerUrl(c.input)).toBe(c.expected);
    });
  }
});

describe('connectE2ee normalizes the server URL (sync.md)', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockSaveAppState.mockClear();
  });

  it('trims surrounding whitespace before connecting AND persisting', async () => {
    await connectE2ee('  https://notes.example.com  ', 'pw');

    const connectArgs = mockInvoke.mock.calls.find((c) => c[0] === 'e2ee_connect');
    expect(connectArgs).toBeDefined();
    expect((connectArgs![1] as { input: { serverUrl: string } }).input.serverUrl).toBe(
      'https://notes.example.com',
    );

    const savedState = mockSaveAppState.mock.calls.at(-1)![0] as { e2eeServerUrl: string };
    expect(savedState.e2eeServerUrl).toBe('https://notes.example.com');
  });

  it('rejects a schemeless URL before invoking the connect command', async () => {
    await expect(connectE2ee('notes.example.com', 'pw')).rejects.toThrow(
      /Add http:\/\/ or https:\/\//,
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
