import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEV_PORTS_FILE, writeIosDevPorts } from './ios-dev-ports.mjs';
import { portsFor } from './lib/slot.mjs';

describe('iOS built developer ports', () => {
  let resources;
  beforeEach(() => {
    resources = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-dev-ports-'));
  });
  afterEach(() => fs.rmSync(resources, { recursive: true, force: true }));

  it('projects the actual build worktree slot and preserves sibling resources', () => {
    const sibling = path.join(resources, 'Info.plist');
    fs.writeFileSync(sibling, 'preserved');
    for (const root of ['/tmp/wt', '/Users/mason/futo-notes']) {
      const file = writeIosDevPorts(resources, 'Debug', root);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
        crashlogPort: portsFor(root).crashlog,
      });
    }
    expect(fs.readFileSync(sibling, 'utf8')).toBe('preserved');
  });

  it('does not create developer config for a release build', () => {
    expect(writeIosDevPorts(resources, 'Release')).toBeNull();
    expect(fs.existsSync(path.join(resources, DEV_PORTS_FILE))).toBe(false);
  });

  it('rejects invalid output paths and arguments before writing', () => {
    expect(() => writeIosDevPorts('', 'Debug')).toThrow('directory and configuration');
    expect(() => writeIosDevPorts(resources, '')).toThrow('directory and configuration');
    const file = path.join(resources, 'not-directory');
    fs.writeFileSync(file, 'preserved');
    expect(() => writeIosDevPorts(file, 'Debug')).toThrow('not a directory');
    expect(fs.readFileSync(file, 'utf8')).toBe('preserved');
  });

  it('runs through a symlinked CLI entry on the build host', () => {
    const alias = path.join(resources, 'ports.mjs');
    fs.symlinkSync(path.resolve(import.meta.dirname, 'ios-dev-ports.mjs'), alias);
    const result = spawnSync(process.execPath, [alias, resources, 'Debug'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(resources, DEV_PORTS_FILE), 'utf8'))).toEqual({
      crashlogPort: portsFor(path.resolve(import.meta.dirname, '..')).crashlog,
    });
  });
});
