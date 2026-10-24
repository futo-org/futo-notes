import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isInside(directory, file) {
  const relative = path.relative(directory, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function resolveLocal(requireFromRoot, nodeModules, moduleName) {
  try {
    const canonicalNodeModules = fs.realpathSync(nodeModules);
    const resolved = fs.realpathSync(requireFromRoot.resolve(moduleName));
    return isInside(canonicalNodeModules, resolved) ? resolved : null;
  } catch {
    return null;
  }
}

// Milkdown exposes import-only subpaths, so createRequire.resolve cannot check
// them. Let Node resolve in a module rooted at the checkout, then require the
// resolved file to exist inside this checkout's installed dependency tree.
function resolvesLocalImport(root, nodeModules, moduleName) {
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'console.log(import.meta.resolve(process.argv[1]))',
        moduleName,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.status !== 0) return false;
    return isInside(
      fs.realpathSync(nodeModules),
      fs.realpathSync(fileURLToPath(result.stdout.trim())),
    );
  } catch {
    return false;
  }
}

function hasCompatibleWs(requireFromRoot, nodeModules, packagePath) {
  const entry = resolveLocal(requireFromRoot, nodeModules, 'ws');
  const metadataPath = resolveLocal(requireFromRoot, nodeModules, 'ws/package.json');
  if (!entry || !metadataPath) return false;
  try {
    const installed = JSON.parse(fs.readFileSync(metadataPath, 'utf8')).version;
    const workspace = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const declared = workspace.devDependencies?.ws ?? workspace.dependencies?.ws ?? '';
    const wantedMajor = /(?:^|\D)(\d+)(?:\.|$)/.exec(declared)?.[1];
    const actualMajor = /^\d+/.exec(installed)?.[0];
    delete requireFromRoot.cache[entry];
    return (
      Boolean(wantedMajor) &&
      wantedMajor === actualMajor &&
      typeof requireFromRoot(entry) === 'function'
    );
  } catch {
    return false;
  }
}

export function missingWorkspaceDependencies(root = SCRIPT_ROOT) {
  const packagePath = path.join(root, 'package.json');
  const nodeModules = path.join(root, 'node_modules');
  const requireFromRoot = createRequire(packagePath);
  const missing = [];

  const viteCandidates = process.platform === 'win32' ? ['vite.cmd', 'vite'] : ['vite'];
  if (!viteCandidates.some((name) => fs.existsSync(path.join(nodeModules, '.bin', name)))) {
    missing.push('node_modules/.bin/vite');
  }

  if (!resolveLocal(requireFromRoot, nodeModules, 'ajv/dist/2020.js')) {
    missing.push('ajv/dist/2020.js');
  }

  if (!hasCompatibleWs(requireFromRoot, nodeModules, packagePath)) {
    missing.push('the workspace-compatible ws package');
  }

  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  if (declared['@milkdown/kit'] && !resolvesLocalImport(root, nodeModules, '@milkdown/kit/core')) {
    missing.push('@milkdown/kit/core');
  }
  if (
    declared['vite-plugin-singlefile'] &&
    !resolveLocal(requireFromRoot, nodeModules, 'vite-plugin-singlefile')
  ) {
    missing.push('vite-plugin-singlefile');
  }

  return missing;
}

function runInstall(root) {
  const result = spawnSync('pnpm', ['install'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`pnpm install exited ${result.status ?? 'without a status'}`);
}

export function ensureWorkspaceDependencies(root = SCRIPT_ROOT, install = runInstall) {
  let missing = missingWorkspaceDependencies(root);
  if (missing.length === 0) return { installed: false, missing };

  console.log(`==> node_modules missing or stale (${missing.join(', ')}) — pnpm install`);
  install(root);
  missing = missingWorkspaceDependencies(root);
  if (missing.length > 0) {
    throw new Error(
      `workspace dependencies are still missing or incompatible after pnpm install: ${missing.join(', ')}. Remove node_modules and run pnpm install.`,
    );
  }
  return { installed: true, missing };
}

function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1] ?? '') : SCRIPT_ROOT;
  try {
    ensureWorkspaceDependencies(root);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
