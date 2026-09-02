// What these pin: the sync server is a separate repo that got rewritten in Go,
// and four launchers had `bun src/index.ts` hard-coded — so the rewrite broke
// the cross-platform suite, `just qa-server`, scripts/start-test-server.sh and
// two CI jobs at once, and one of them was still red days later. The fix was a
// single owner (sync-server.mjs) plus a pinned release; these tests hold both.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PINNED_SERVER_VERSION,
  SERVER_PIN,
  syncServerBinary,
  syncServerEnv,
} from './sync-server.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/** Every file that starts a sync server. Adding a fifth belongs in this list. */
const LAUNCHERS = [
  'tests/lib/sync-test-server.mjs',
  'scripts/qa.mjs',
  'scripts/start-test-server.sh',
  '.gitlab-ci.yml',
];

describe('the pin', () => {
  it('names one binary per supported platform, each stamped with the pinned version', () => {
    // A half-done bump — version changed, assets left behind — downloads a 404
    // in CI and nowhere else, which is the worst place to find out.
    for (const [platform, entry] of Object.entries(SERVER_PIN.binaries)) {
      expect(entry.asset, `${platform} asset`).toContain(PINNED_SERVER_VERSION);
      expect(entry.sha256, `${platform} sha256`).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const platform of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
      expect(Object.keys(SERVER_PIN.binaries)).toContain(platform);
    }
  });
});

describe('server environment', () => {
  it('gives each server its own SQLite database and blob dir', () => {
    // This is what replaced a shared Postgres database and the per-scenario
    // TRUNCATE that wiped a concurrent run's sessions.
    const a = mkdtempSync(join(tmpdir(), 'sync-server-env-'));
    const b = mkdtempSync(join(tmpdir(), 'sync-server-env-'));
    const envA = syncServerEnv({ port: 3100, dataDir: a });
    const envB = syncServerEnv({ port: 3101, dataDir: b });

    expect(envA.DATABASE_URL).toBe(`sqlite:${join(a, 'notes.db')}`);
    expect(envA.DATABASE_URL).not.toBe(envB.DATABASE_URL);
    expect(envA.BLOB_DIR).not.toBe(envB.BLOB_DIR);
    expect(existsSync(envA.BLOB_DIR)).toBe(true);
    expect(envA.AUTH_MODE).toBe('password');
    // Plaintext: the Go server takes the password itself, where its TypeScript
    // predecessor needed a hash computed by a `bun src/index.ts hash` call.
    expect(envA.FUTO_NOTES_PASSWORD).toBeTruthy();
    expect(envA.FUTO_NOTES_PASSWORD_HASH).toBeUndefined();
  });
});

describe('resolution', () => {
  it('honors an explicit binary and says so when it is not there', async () => {
    process.env.FUTO_NOTES_E2EE_SERVER_BIN = join(tmpdir(), 'no-such-server-binary');
    try {
      await expect(syncServerBinary()).rejects.toThrow(/does not exist/);
    } finally {
      delete process.env.FUTO_NOTES_E2EE_SERVER_BIN;
    }
  });

  it('tells a stale TypeScript checkout what is actually wrong', async () => {
    // The papercut this closes: the harness probed for package.json and said
    // "server repo not found" about a checkout that was sitting right there.
    process.env.FUTO_NOTES_E2EE_SERVER_REPO = mkdtempSync(join(tmpdir(), 'not-a-go-server-'));
    try {
      await expect(syncServerBinary()).rejects.toThrow(/no go\.mod[\s\S]*Go project since/);
    } finally {
      delete process.env.FUTO_NOTES_E2EE_SERVER_REPO;
    }
  });
});

/** Comments explain the history on purpose; only executable lines are the rule. */
function executableLines(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/|\*)/.test(line))
    .join('\n');
}

describe('every launcher', () => {
  it('goes through this module instead of naming a server command itself', () => {
    for (const launcher of LAUNCHERS) {
      const source = readFileSync(join(REPO_ROOT, launcher), 'utf8');
      expect(executableLines(source), `${launcher} still runs the TypeScript server`).not.toMatch(
        /src\/index\.ts/,
      );
      expect(source, `${launcher} does not resolve the server through sync-server.mjs`).toMatch(
        /sync-server\.mjs/,
      );
    }
  });
});
