#!/usr/bin/env node
// `just skill-validate <skill>` runs Codex's installed quick_validate.py with
// PyYAML in an isolated uv environment. The system interpreter and installed
// skills stay untouched. Cache/env files live in one owned temporary directory;
// no project Python environment or routine CI dependency is introduced.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function runSkillValidation(skill, { env = process.env, exec = spawnSync } = {}) {
  const codexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  const validator = path.resolve(
    codexHome,
    'skills/.system/skill-creator/scripts/quick_validate.py',
  );
  if (!fs.existsSync(validator))
    throw new Error(`System skill validator not found at ${validator}; check Codex or CODEX_HOME.`);
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-skill-validation-env-'));
  try {
    const result = exec(
      'uv',
      [
        'run',
        '--isolated',
        '--no-project',
        '--no-config',
        '--no-managed-python',
        '--no-python-downloads',
        '--with',
        'PyYAML',
        '--',
        'python',
        validator,
        skill,
      ],
      { env: { ...env, UV_CACHE_DIR: cache }, stdio: 'inherit' },
    );
    if (result.error) {
      if (result.error.code === 'ENOENT')
        console.error('uv is required for isolated skill validation; install uv and retry.');
      else console.error(result.error.message);
      return 1;
    }
    return result.status ?? 1;
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help')
      console.log('Usage: just skill-validate <skill>');
    else {
      if (args.length !== 1) throw new Error('Usage: just skill-validate <skill>');
      process.exitCode = runSkillValidation(args[0]);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
