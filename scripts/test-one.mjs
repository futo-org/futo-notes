#!/usr/bin/env node
/** Run explicit editor-package test paths under that package's Vitest config.
 * All other invocations retain the root config, including -t patterns.
 * An editor selector must be first and the sole file filter; flags pass through.
 * The just test-one recipe owns dependency setup and invokes this dispatcher.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCLI } from 'vitest/node';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function testRuns(args) {
  const relative = (arg) =>
    path.isAbsolute(arg) ? path.relative(root, arg) : arg.replace(/^\.\//, '');
  const editorPath = (arg) =>
    typeof arg === 'string' && relative(arg).startsWith('packages/editor/');
  if (!args.some(editorPath)) return [{ cwd: root, args }];
  const { filter } = parseCLI(['vitest', 'run', ...args]);
  if (!filter.some(editorPath)) return [{ cwd: root, args }];
  if (!editorPath(args[0]) || filter.length !== 1 || filter[0] !== args[0]) {
    throw new Error(
      'Put the sole editor selector first: just test-one packages/editor/src/bridge.test.ts [options]. Run mixed selectors in separate just test-one commands.',
    );
  }
  return [
    {
      cwd: path.join(root, 'packages/editor'),
      args: [relative(args[0]).slice('packages/editor/'.length), ...args.slice(1)],
    },
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    for (const run of testRuns(process.argv.slice(2))) {
      const result = spawnSync(path.join(root, 'node_modules/.bin/vitest'), ['run', ...run.args], {
        cwd: run.cwd,
        stdio: 'inherit',
      });
      if (result.error) console.error(result.error.message);
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        break;
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
