#!/usr/bin/env node
// Run browser tests with the official image matching the installed Playwright
// package. Rootless Podman supplies Linux browser libraries without changing the
// host. Only the owned --rm container is cleaned up; image/cache data stays put.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';

export function browserContainerArgs({ root, version, engine, runName, tests }) {
  if (!['chromium', 'firefox', 'webkit'].includes(engine))
    throw new Error('Unknown browser engine');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected an installed release version');
  if (root.includes(':')) throw new Error('Container checkout path cannot contain a colon');
  if (!/^[A-Za-z0-9_-]+$/.test(runName)) throw new Error('Invalid evidence run name');
  return [
    'run',
    '--rm',
    '--init',
    '--userns=keep-id',
    '--network',
    'none',
    '--security-opt',
    'label=disable',
    '--shm-size=1g',
    '--volume',
    `${root}:/work:rw`,
    '--workdir',
    '/work',
    '--env',
    `FUTO_BROWSER_ENGINE=${engine}`,
    '--env',
    `FUTO_VERIFICATION_DIR=/work/verification-runs/${runName}`,
    '--env',
    'CI=1',
    `mcr.microsoft.com/playwright:v${version}-noble`,
    'node',
    'node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'playwright.container.config.ts',
    ...tests,
  ];
}

if (import.meta.main) {
  try {
    if (process.platform !== 'linux') throw new Error('Rootless browser containers require Linux');
    const [engine = 'webkit', ...tests] = process.argv.slice(2);
    const root = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
    const require = createRequire(import.meta.url);
    const { version } = require('@playwright/test/package.json');
    // Validate arguments before creating any output directory.
    browserContainerArgs({ root, version, engine, runName: 'check', tests });
    const info = spawnSync('podman', ['info', '--format', '{{.Host.Security.Rootless}}'], {
      encoding: 'utf8',
    });
    if (info.error) throw info.error;
    if (info.status !== 0 || info.stdout.trim() !== 'true')
      throw new Error(`Rootless Podman is required: ${info.stderr.trim() || info.stdout.trim()}`);
    const evidenceRoot = path.join(root, 'verification-runs');
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(evidenceRoot, 'browser-container-'));
    console.log(`Browser ${engine}, Playwright ${version}; evidence: ${runDir}`);
    const result = spawnSync(
      'podman',
      browserContainerArgs({ root, version, engine, runName: path.basename(runDir), tests }),
      { stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 128 + (constants.signals[result.signal] ?? 0);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
