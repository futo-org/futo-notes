import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// connectE2ee reaches Tauri (invoke/listen) and app-state persistence; mock
// those so the test exercises only the URL-normalization contract.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve({ token: 't', userId: 'u', collectionId: 'c' })),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('./appState', () => ({
  getAppState: vi.fn(() => ({})),
  saveAppState: vi.fn(() => Promise.resolve()),
}));

import { invoke } from '@tauri-apps/api/core';
import { saveAppState } from './appState';
import { validateSyncServerUrl, connectE2ee } from './syncServiceE2ee';

const mockInvoke = vi.mocked(invoke);
const mockSaveAppState = vi.mocked(saveAppState);

// Shared cross-shell case-set. The SAME fixture is the source of truth for the
// Swift (validateServerURL) and Kotlin (validateServerUrl) copies — asserting
// the TS copy against it here is what keeps the three from silently drifting.
const serverUrlFixture = JSON.parse(
  readFileSync(new URL('../../tests/conformance/server-url.json', import.meta.url), 'utf8'),
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
    // A pasted URL with whitespace passes validation (which trims); the raw
    // value must NOT be what we connect with or store, or the connection dies
    // with the opaque transport error the validation exists to prevent.
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
