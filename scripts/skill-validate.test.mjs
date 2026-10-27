import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runSkillValidation } from './skill-validate.mjs';

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture({ homeFallback = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-skill-validation-'));
  dirs.push(dir);
  const home = path.join(dir, 'User home');
  const codex = homeFallback ? path.join(home, '.codex') : path.join(dir, 'Codex home');
  const validator = path.join(codex, 'skills/.system/skill-creator/scripts/quick_validate.py');
  fs.mkdirSync(path.dirname(validator), { recursive: true });
  fs.writeFileSync(validator, '# existing upstream validator fixture\n');
  return { dir, home, codex, validator };
}

it.skipIf(process.platform === 'win32')(
  'the public recipe preserves literal skill argv and cleans only its private uv cache',
  () => {
    const f = fixture();
    const bin = path.join(f.dir, 'bin');
    const capture = path.join(f.dir, 'capture.json');
    const sentry = path.join(f.dir, 'sentry');
    const skill = `my skill;$(touch ${sentry})`;
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'uv'),
      `#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(process.env.FUTO_SKILL_CAPTURE,JSON.stringify({args:process.argv.slice(2),cache:process.env.UV_CACHE_DIR,cacheExisted:fs.existsSync(process.env.UV_CACHE_DIR)}));
`,
      { mode: 0o755 },
    );
    const result = spawnSync('just', ['skill-validate', skill], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: f.codex,
        PATH: bin + path.delimiter + process.env.PATH,
        FUTO_SKILL_CAPTURE: capture,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(proof.args.slice(-3)).toEqual(['python', f.validator, skill]);
    expect(proof.args).toContain('PyYAML');
    expect(proof.cacheExisted).toBe(true);
    expect(fs.existsSync(proof.cache)).toBe(false);
    expect(fs.existsSync(sentry)).toBe(false);
    expect(fs.readFileSync(f.validator, 'utf8')).toBe('# existing upstream validator fixture\n');
  },
);

it.each([37, null])('preserves child failure %s and removes only its own cache', (status) => {
  const f = fixture();
  const keep = path.join(f.dir, 'keep');
  fs.writeFileSync(keep, 'owned by caller');
  let cache;
  const result = runSkillValidation('skill path', {
    env: { CODEX_HOME: f.codex },
    exec: (_command, _args, options) => {
      cache = options.env.UV_CACHE_DIR;
      expect(fs.existsSync(cache)).toBe(true);
      fs.writeFileSync(path.join(cache, 'uv-output'), 'temporary');
      return { status, signal: status === null ? 'SIGTERM' : null };
    },
  });
  expect(result).toBe(status ?? 1);
  expect(fs.existsSync(cache)).toBe(false);
  expect(fs.readFileSync(keep, 'utf8')).toBe('owned by caller');
});

it('uses the caller HOME default when CODEX_HOME is unset', () => {
  const f = fixture({ homeFallback: true });
  const exec = vi.fn(() => ({ status: 0 }));
  expect(runSkillValidation('skill', { env: { HOME: f.home }, exec })).toBe(0);
  expect(exec.mock.calls[0][1].slice(-2)).toEqual([f.validator, 'skill']);
});

it('names the optional uv prerequisite and cleans up when it is missing', () => {
  const f = fixture();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  let cache;
  const result = runSkillValidation('skill', {
    env: { CODEX_HOME: f.codex },
    exec: (_command, _args, options) => {
      cache = options.env.UV_CACHE_DIR;
      return { status: null, error: { code: 'ENOENT' } };
    },
  });
  expect(result).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('uv is required'));
  expect(fs.existsSync(cache)).toBe(false);
});

it('rejects a missing installed validator before invoking uv', () => {
  const f = fixture();
  fs.unlinkSync(f.validator);
  const exec = vi.fn();
  expect(() => runSkillValidation('skill', { env: { CODEX_HOME: f.codex }, exec })).toThrow(
    'CODEX_HOME',
  );
  expect(exec).not.toHaveBeenCalled();
});
