import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('papercut-sweep install-timer.sh', () => {
  let homeDir;
  let fakeBin;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sweep-install-'));
    mkdirSync(join(homeDir, '.config', 'futo-notes-papercut-sweep'), { recursive: true });
    writeFileSync(
      join(homeDir, '.config', 'futo-notes-papercut-sweep', 'env'),
      'GITLAB_TOKEN=test\n',
    );
    fakeBin = join(homeDir, 'bin');
    mkdirSync(fakeBin);
    for (const tool of ['systemctl', 'claude', 'just']) {
      writeFileSync(join(fakeBin, tool), '#!/bin/sh\nexit 0\n');
      chmodSync(join(fakeBin, tool), 0o755);
    }
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('renders both units with node, repo, and PATH substituted and no placeholders left', async () => {
    const PATH = `${fakeBin}:${process.env.PATH}`;
    await execFileAsync('bash', [join(import.meta.dirname, 'install-timer.sh')], {
      env: { ...process.env, HOME: homeDir, PATH },
    });
    const unitDir = join(homeDir, '.config', 'systemd', 'user');
    const service = readFileSync(join(unitDir, 'futo-notes-papercut-sweep.service'), 'utf8');
    const timer = readFileSync(join(unitDir, 'futo-notes-papercut-sweep.timer'), 'utf8');
    const repoDir = resolve(import.meta.dirname, '..', '..');

    expect(service).toContain(`Documentation=file:${repoDir}/scripts/papercut-sweep/README.md`);
    expect(service).toContain(`${repoDir}/scripts/papercut-sweep/sweep.mjs`);
    expect(service).toContain(`Environment=PATH=${PATH}`);
    expect(service).toContain('EnvironmentFile=%h/.config/futo-notes-papercut-sweep/env');
    expect(timer).toContain('OnCalendar=Mon');
    expect(`${service}\n${timer}`).not.toMatch(/__(NODE_BIN|REPO_DIR|PATH)__/);
  });

  it('refuses to install without the credential file', async () => {
    rmSync(join(homeDir, '.config', 'futo-notes-papercut-sweep', 'env'));
    await expect(
      execFileAsync('bash', [join(import.meta.dirname, 'install-timer.sh')], {
        env: { ...process.env, HOME: homeDir, PATH: `${fakeBin}:${process.env.PATH}` },
      }),
    ).rejects.toThrow(/Missing/);
  });
});
