// Immutable source transfer: Git selects source; ignored builds/caches are never archived.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';

export function snapshotSource(root, scratch) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sha = git('rev-parse', 'HEAD');
  const base = git('merge-base', 'HEAD', 'origin/main');
  if (
    git('ls-files', '--stage')
      .split('\n')
      .some((line) => line.startsWith('160000 '))
  )
    throw new Error('Submodule source requires explicit snapshot support');
  const selected = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  );
  const files = [...new Set(selected.split('\0').filter(Boolean))]
    .filter(
      (file) =>
        (existsSync(path.join(root, file)) || lstatIfLink(path.join(root, file))) &&
        !lstatSync(path.join(root, file)).isDirectory(),
    )
    .sort();
  for (const file of files) {
    if (
      file === '.git' ||
      file.startsWith('.git/') ||
      /^(target|node_modules|dist)(\/|$)/.test(file)
    )
      throw new Error(`Refusing generated/private source path: ${file}`);
    let parent = path.dirname(file);
    while (parent !== '.') {
      if (lstatSync(path.join(root, parent)).isSymbolicLink())
        throw new Error(`Cannot snapshot source through a directory symlink: ${file}`);
      parent = path.dirname(parent);
    }
  }
  writeFileSync(path.join(scratch, 'files.nul'), files.join('\0') + '\0');
  writeFileSync(path.join(scratch, 'manifest.json'), JSON.stringify(files));
  execFileSync(
    'tar',
    [
      '--null',
      '--no-recursion',
      '-T',
      path.join(scratch, 'files.nul'),
      '-czf',
      path.join(scratch, 'source.tar.gz'),
    ],
    { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
  const bundle = sha !== base;
  if (bundle)
    execFileSync(
      'git',
      ['bundle', 'create', '--quiet', path.join(scratch, 'source.bundle'), 'HEAD', `^${base}`],
      { cwd: root },
    );
  const digest = createHash('sha256')
    .update(readFileSync(path.join(scratch, 'source.tar.gz')))
    .digest('hex');
  const id = createHash('sha256')
    .update(`${hostname()}\0${realpathSync(root)}`)
    .digest('hex')
    .slice(0, 12);
  return { sha, base, digest, id, bundle, files };
}

function lstatIfLink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
