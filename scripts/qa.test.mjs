import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const QA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qa.mjs');

// pc_c4b48ce7a32e: two QA agents (Android + iOS) sharing one worktree — the
// Android agent's cleanup released, and could shut down, the iOS agent's
// simulator, because `release` took every claim the worktree held. These run
// qa.mjs for real against a throwaway HOME and git repo; without --shutdown
// release only deletes owner files, so no device is touched.
describe('qa.mjs release', () => {
  let home;
  let root;

  const ownerFile = (platform) =>
    path.join(home, '.futo-notes-qa', 'devices', `${platform}-futo-qa-0.json`);

  function release(...args) {
    return spawnSync(process.execPath, [QA, 'release', ...args], {
      cwd: root,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-home-'));
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wt-')));
    execFileSync('git', ['init', '-q', root]);
    fs.mkdirSync(path.dirname(ownerFile('ios')), { recursive: true });
    for (const platform of ['ios', 'android']) {
      fs.writeFileSync(ownerFile(platform), JSON.stringify({ worktree: root }));
    }
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('releases only the named platform', () => {
    const result = release('android');
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(ownerFile('android'))).toBe(false);
    expect(fs.existsSync(ownerFile('ios'))).toBe(true);
  });

  it('releases every platform when none is named', () => {
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(ownerFile('android'))).toBe(false);
    expect(fs.existsSync(ownerFile('ios'))).toBe(false);
  });

  it('rejects an unknown platform instead of releasing everything', () => {
    const result = release('windows');
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(ownerFile('android'))).toBe(true);
    expect(fs.existsSync(ownerFile('ios'))).toBe(true);
  });
});
