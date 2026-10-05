import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts/check-node-modules.mjs');

let scratch;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'futo-node-modules-guard-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runGuard(dir) {
  return spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf8' });
}

describe('node_modules guard', () => {
  it('fails and names the install command when node_modules is absent', () => {
    const result = runGuard(scratch);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules is missing');
    expect(result.stderr).toContain('just install');
  });

  it('passes once node_modules exists', () => {
    mkdirSync(join(scratch, 'node_modules'));

    const result = runGuard(scratch);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('defaults to the repo root, which is installed while the suite runs', () => {
    const result = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });

    expect(result.status).toBe(0);
  });

  it('runs before every other dependency of `just check`', () => {
    const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');
    const check = /^check:(.*)$/m.exec(justfile);

    expect(check?.[1].trim().split(/\s+/)[0]).toBe('check-node-modules');
  });
});

// RC-69: an incremental `pnpm install` can leave a patch-hash directory holding the
// unpatched package. The fixture mimics pnpm's layout: a real copy under
// node_modules/.pnpm/<pkg>@<ver>_patch_hash=<h>/node_modules/<pkg>, linked from
// node_modules/<pkg> (direct) and from another store entry (transitive).
describe('patchedDependencies guard', () => {
  const PATCH = [
    'diff --git a/lib/a.js b/lib/a.js',
    'index 1111111..2222222 100644',
    '--- a/lib/a.js',
    '+++ b/lib/a.js',
    '@@ -1,4 +1,5 @@',
    ' const one = 1;',
    '-const two = 2;',
    '+const two = 22; // PATCHED',
    '+const extra = true;',
    ' const three = 3;',
    ' const four = 4;',
    'diff --git a/lib/b.js b/lib/b.js',
    'index 3333333..4444444 100644',
    '--- a/lib/b.js',
    '+++ b/lib/b.js',
    '@@ -1,2 +1,3 @@',
    ' export const b = 1;',
    '+export const patchedB = 2;',
    ' export const c = 3;',
    '',
  ].join('\n');
  const A_PATCHED =
    'const one = 1;\nconst two = 22; // PATCHED\nconst extra = true;\nconst three = 3;\nconst four = 4;\n';
  const A_UPSTREAM = 'const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\n';
  const B_PATCHED = 'export const b = 1;\nexport const patchedB = 2;\nexport const c = 3;\n';
  const B_UPSTREAM = 'export const b = 1;\nexport const c = 3;\n';

  /** Lay out a fake install; returns the installed package dir. */
  function install({ a = A_PATCHED, b = B_PATCHED, version = '1.0.0', name = 'fakepkg' } = {}) {
    writeFileSync(
      join(scratch, 'pnpm-workspace.yaml'),
      `patchedDependencies:\n  ${name}@1.0.0: patches/${name}@1.0.0.patch\n\nshamefullyHoist: true\n`,
    );
    mkdirSync(join(scratch, 'patches'), { recursive: true });
    writeFileSync(join(scratch, `patches/${name}@1.0.0.patch`), PATCH);
    const store = join(scratch, 'node_modules/.pnpm');
    const pkgDir = join(store, `${name}@1.0.0_patch_hash=abc/node_modules/${name}`);
    mkdirSync(join(pkgDir, 'lib'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
    writeFileSync(join(pkgDir, 'lib/a.js'), a);
    writeFileSync(join(pkgDir, 'lib/b.js'), b);
    symlinkSync(pkgDir, join(scratch, 'node_modules', name));
    return pkgDir;
  }

  it('passes when the patch is applied to the installed package', () => {
    install();

    const result = runGuard(scratch);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails naming the package, the file and the recovery command when the copy is unpatched', () => {
    install({ a: A_UPSTREAM, b: B_UPSTREAM });

    const result = runGuard(scratch);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fakepkg@1.0.0');
    expect(result.stderr).toContain('NOT applied');
    expect(result.stderr).toContain('lib/a.js');
    expect(result.stderr).toContain('rm -rf node_modules && pnpm install');
  });

  it('fails when only part of the patch is applied (a dropped, earlier-vs-later patch)', () => {
    install({ b: B_UPSTREAM });

    const result = runGuard(scratch);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lib/b.js: 1 of 1 hunks not applied');
    expect(result.stderr).not.toContain('lib/a.js');
  });

  it('checks a copy that only a store dependency links to, not just node_modules/<pkg>', () => {
    const pkgDir = install();
    const other = join(
      scratch,
      'node_modules/.pnpm/otherpkg@1.0.0_patch_hash=old/node_modules/fakepkg',
    );
    mkdirSync(join(other, 'lib'), { recursive: true });
    writeFileSync(
      join(other, 'package.json'),
      JSON.stringify({ name: 'fakepkg', version: '1.0.0' }),
    );
    writeFileSync(join(other, 'lib/a.js'), A_UPSTREAM);
    writeFileSync(join(other, 'lib/b.js'), B_UPSTREAM);
    const consumer = join(scratch, 'node_modules/.pnpm/consumer@1.0.0/node_modules');
    mkdirSync(consumer, { recursive: true });
    symlinkSync(other, join(consumer, 'fakepkg'));

    const result = runGuard(scratch);

    expect(pkgDir).not.toBe(other);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('otherpkg@1.0.0_patch_hash=old');
  });

  it('ignores an installed version the patch does not target', () => {
    install({ a: A_UPSTREAM, b: B_UPSTREAM, version: '2.0.0' });

    expect(runGuard(scratch).status).toBe(0);
  });

  it('handles a scoped package name in pnpm-workspace.yaml', () => {
    const pkgDir = join(scratch, 'node_modules/.pnpm/@s+p@1.0.0_patch_hash=abc/node_modules/@s/p');
    mkdirSync(join(pkgDir, 'lib'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@s/p', version: '1.0.0' }));
    writeFileSync(join(pkgDir, 'lib/a.js'), A_UPSTREAM);
    writeFileSync(join(pkgDir, 'lib/b.js'), B_UPSTREAM);
    mkdirSync(join(scratch, 'node_modules/@s'), { recursive: true });
    symlinkSync(pkgDir, join(scratch, 'node_modules/@s/p'));
    mkdirSync(join(scratch, 'patches'));
    writeFileSync(join(scratch, 'patches/p.patch'), PATCH);
    writeFileSync(
      join(scratch, 'pnpm-workspace.yaml'),
      "patchedDependencies:\n  '@s/p@1.0.0': patches/p.patch\n",
    );

    const result = runGuard(scratch);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('@s/p@1.0.0');
  });

  it('does not modify the installed package', () => {
    const pkgDir = install({ a: A_UPSTREAM, b: B_UPSTREAM });

    runGuard(scratch);

    expect(readFileSync(join(pkgDir, 'lib/a.js'), 'utf8')).toBe(A_UPSTREAM);
    expect(readFileSync(join(pkgDir, 'lib/b.js'), 'utf8')).toBe(B_UPSTREAM);
  });
});
