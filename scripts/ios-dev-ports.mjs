#!/usr/bin/env node
// Project this build host's worktree ports into the Debug app's built bundle.
// Invoked by Xcode's post-build phase; Release never reads developer config.
import fs from 'node:fs';
import path from 'node:path';
import { portsFor } from './lib/slot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const DEV_PORTS_FILE = 'futo-dev-ports.json';

export function writeIosDevPorts(resourcesDir, configuration, root = ROOT) {
  if (!resourcesDir || !configuration)
    throw new Error('Expected built resources directory and configuration');
  if (configuration !== 'Debug') return null;
  if (!fs.statSync(resourcesDir).isDirectory())
    throw new Error('Built resources path is not a directory');
  const file = path.join(resourcesDir, DEV_PORTS_FILE);
  fs.writeFileSync(file, JSON.stringify({ crashlogPort: portsFor(root).crashlog }) + '\n');
  return file;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4)
      throw new Error('usage: ios-dev-ports.mjs <built-resources-dir> <configuration>');
    writeIosDevPorts(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
