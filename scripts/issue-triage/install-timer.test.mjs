import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('install-timer.sh', () => {
  let homeDir;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'triage-install-'));
    mkdirSync(join(homeDir, '.config', 'futo-notes-issue-triage'), { recursive: true });
    writeFileSync(
      join(homeDir, '.config', 'futo-notes-issue-triage', 'env'),
      'ZULIP_TRIAGE_BOT_KEY=test\n',
    );

    const fakeBin = join(homeDir, 'bin');
    mkdirSync(fakeBin);
    const systemctl = join(fakeBin, 'systemctl');
    writeFileSync(systemctl, '#!/bin/sh\nexit 0\n');
    chmodSync(systemctl, 0o755);
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('renders each unit independently with the actual repository path', async () => {
    const fakeBin = join(homeDir, 'bin');
    await execFileAsync('bash', [join(import.meta.dirname, 'install-timer.sh')], {
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    const unitDir = join(homeDir, '.config', 'systemd', 'user');
    const service = readFileSync(join(unitDir, 'futo-notes-issue-triage.service'), 'utf8');
    const timer = readFileSync(join(unitDir, 'futo-notes-issue-triage.timer'), 'utf8');
    const repoDir = resolve(import.meta.dirname, '..', '..');

    expect(service).toContain(`Documentation=file:${repoDir}/scripts/issue-triage/README.md`);
    expect(service).not.toContain('[Timer]');
    expect(timer).toContain(`Documentation=file:${repoDir}/scripts/issue-triage/README.md`);
    expect(`${service}\n${timer}`).not.toContain('__REPO_DIR__');
  });

  // An installed poller whose OnFailure= target does not exist fails silently
  // in exactly the way this alerting was added to prevent.
  it('installs the failure-alert unit the poller triggers, with node resolved', async () => {
    const fakeBin = join(homeDir, 'bin');
    await execFileAsync('bash', [join(import.meta.dirname, 'install-timer.sh')], {
      env: { ...process.env, HOME: homeDir, PATH: `${fakeBin}:${process.env.PATH}` },
    });

    const unitDir = join(homeDir, '.config', 'systemd', 'user');
    const service = readFileSync(join(unitDir, 'futo-notes-issue-triage.service'), 'utf8');
    const failure = readFileSync(join(unitDir, 'futo-notes-issue-triage-failure.service'), 'utf8');

    expect(service).toContain('OnFailure=futo-notes-issue-triage-failure.service');
    expect(failure).toContain('alertFailure.mjs');
    expect(failure).not.toContain('__NODE_BIN__');
    expect(failure).not.toContain('__REPO_DIR__');
    // No OnFailure= directive here (the comment explaining its absence is
    // fine), or a Zulip outage becomes a self-triggering loop.
    expect(failure).not.toMatch(/^OnFailure=/m);
  });
});
