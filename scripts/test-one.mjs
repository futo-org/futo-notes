#!/usr/bin/env node
/** Run explicit editor-package test paths under that package's Vitest config.
 * All other invocations retain the root config, including -t patterns.
 * Mixed root/editor file lists run once per owner; every failure propagates.
 * The just test-one recipe owns dependency setup and invokes this dispatcher.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCLI } from 'vitest/node';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function testRuns(args) {
  const selectors = new Set(parseCLI(['vitest', 'run', ...args]).filter);
  const relative = (arg) =>
    path.isAbsolute(arg) ? path.relative(root, arg) : arg.replace(/^\.\//, '');
  const editorPath = (arg) => selectors.has(arg) && relative(arg).startsWith('packages/editor/');
  const rootPath = (arg) =>
    selectors.has(arg) && /^(src|scripts|tests|scratch)\//.test(relative(arg));
  if (!args.some(editorPath)) return [{ cwd: root, args }];
  const shared = args.filter((arg) => !editorPath(arg) && !rootPath(arg));
  const runs = [
    {
      cwd: path.join(root, 'packages/editor'),
      args: [
        ...args.filter(editorPath).map((arg) => relative(arg).slice('packages/editor/'.length)),
        ...shared,
      ],
    },
  ];
  if (args.some(rootPath)) {
    runs.push({ cwd: root, args: [...args.filter(rootPath), ...shared] });
  }
  return runs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
}
