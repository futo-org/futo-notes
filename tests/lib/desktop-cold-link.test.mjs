import net from 'node:net';
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertViteStopped, runColdLinkProof } from '../desktop-cold-link.mjs';

it.skipIf(process.platform === 'win32')(
  'rejects an evidence symlink before creating any run data outside the checkout',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'cold-link-owned-'));
    const outside = mkdtempSync(join(tmpdir(), 'cold-link-outside-'));
    try {
      symlinkSync(outside, join(root, 'verification-runs'));
      await expect(runColdLinkProof(root)).rejects.toThrow('symlink');
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);

it('refuses an occupied dev-server port and accepts the same port after its owned listener exits', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await expect(assertViteStopped(port)).rejects.toThrow('is occupied');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await expect(assertViteStopped(port)).resolves.toBeUndefined();
});
