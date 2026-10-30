#!/usr/bin/env node
// Fixed Puppet entry point. Only capture reads a supplied manifest; read/close
// resolve a validated UUID under the host-owned evidence directory. No fallback.
import { hostname } from 'node:os';
import process from 'node:process';
import console from 'node:console';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { executePhysicalFixture } from './physical-fixture.mjs';
import { createIOSFixtureExecutor } from './physical-fixture-ios.mjs';
import { physicalFixtureHostPaths } from './physical-fixture-lease.mjs';

import { evidenceRun, readEvidenceJSON } from './physical-fixture-evidence.mjs';

const usage = 'physical-fixture capture --manifest <path> | read|close --run <UUID>';

export async function runPhysicalFixtureCLI(args, runtimeOverrides = {}) {
  const [operation, flag, value, ...extra] = args;
  if (
    extra.length ||
    !value ||
    !(
      (operation === 'capture' && flag === '--manifest') ||
      (['read', 'close'].includes(operation) &&
        flag === '--run' &&
        /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(value))
    )
  )
    throw new Error(usage);
  const root =
    runtimeOverrides.root ?? realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  const scratch = runtimeOverrides.scratch ?? physicalFixtureHostPaths().evidenceDirectory;
  const path = operation === 'capture' ? value : join(evidenceRun(scratch, value), 'manifest.json');
  const plan = readEvidenceJSON(path);
  if (operation !== 'capture' && plan.runID !== value)
    throw new Error('Retained manifest differs from requested run');
  return executePhysicalFixture(operation, plan, {
    root,
    scratch,
    host: hostname(),
    executor: createIOSFixtureExecutor(root),
    ...runtimeOverrides,
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const receipt = await runPhysicalFixtureCLI(process.argv.slice(2));
    console.log(JSON.stringify({ ok: true, kind: 'physical-fixture', receipt }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, kind: 'physical-fixture', error: error.message }));
    process.exitCode = 1;
  }
}
