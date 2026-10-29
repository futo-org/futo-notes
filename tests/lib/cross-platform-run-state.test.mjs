import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { xplatSyncBand } from '../../scripts/lib/slot.mjs';

describe('cross-platform scenario port candidates', () => {
  it('supports the full 51-case desktop/Android sweep inside its worktree band', () => {
    const moduleUrl = new URL('../cross-platform-sync/run-state.mjs', import.meta.url).href;
    // Exercise the actual harness process boundary without Vitest arguments
    // entering its CLI parser. startServer separately verifies availability
    // and child identity before accepting any candidate port.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { allocateServerPort, REPO_ROOT } from ${JSON.stringify(moduleUrl)};
const ports = Array.from({ length: 51 }, () => allocateServerPort());
console.log(JSON.stringify({ ports, root: REPO_ROOT }));`,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const { ports, root } = JSON.parse(result.stdout);
    const band = xplatSyncBand(root);
    expect(ports).toHaveLength(51);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(band.base);
      expect(port + 1).toBeLessThanOrEqual(band.end);
    }
  });
});
