import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ argv: null }));
vi.mock('./mcp-client.mjs', async (original) => ({
  ...(await original()),
  discoverPort: async (logFile) => {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const text = readFileSync(logFile, 'utf8');
      if (text.endsWith('\n')) {
        state.argv = JSON.parse(text);
        throw new Error('fixture argv captured before bridge setup');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('fixture child did not write argv');
  },
}));
import { startDesktopTauriInstance } from './tauri-instance.mjs';

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32').each([
  { name: 'default launch', options: {}, expected: [] },
  {
    name: 'cold link launch',
    options: { args: ['futonotes://license/not-a-license/not-an-activation'] },
    expected: ['futonotes://license/not-a-license/not-an-activation'],
  },
])(
  'passes $name arguments literally to the owned child',
  async ({ options, expected }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-argv-')));
    roots.push(root);
    vi.stubEnv('FUTO_VERIFICATION_DIR', '');
    const bin = join(root, 'target/debug/futo-notes-tauri');
    mkdirSync(join(root, 'target/debug'), { recursive: true });
    writeFileSync(
      bin,
      `#!${process.execPath}\nrequire('fs').writeSync(1, JSON.stringify(process.argv.slice(2))+'\\n');\n`,
      { mode: 0o755 },
    );
    state.argv = null;
    await expect(startDesktopTauriInstance('argv fixture', root, options)).rejects.toThrow(
      'argv captured',
    );
    expect(state.argv).toEqual(expected);
  },
  10000,
);
