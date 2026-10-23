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
  parseCLI(['vitest', 'run', ...args]); // Validate the original invocation first.
  // Ask Vitest about each token occurrence. Matching filter strings loses the
  // distinction when, for example, a -t operand equals a positional filename.
  // Marking one occurrence also avoids maintaining our own list of CLI options.
  const selectors = new Set();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('-')) continue;
    let marker = `__test_one_position_${index}__`;
    while (args.includes(marker)) marker += '_';
    const probe = args.with(index, marker);
    try {
      if (parseCLI(['vitest', 'run', ...probe]).filter.includes(marker)) selectors.add(index);
    } catch {
      // A numeric/enum option operand may reject the marker. A positional file
      // filter accepts any string, so this occurrence is not a file filter.
    }
  }
  const relative = (arg) =>
    path.isAbsolute(arg) ? path.relative(root, arg) : arg.replace(/^\.\//, '');
  const editorPath = (arg, index) =>
    selectors.has(index) && relative(arg).startsWith('packages/editor/');
  const rootPath = (arg, index) => selectors.has(index) && !editorPath(arg, index);
  if (!args.some(editorPath)) return [{ cwd: root, args }];
  const routedArgs = (editor) =>
    args.flatMap((arg, index) => {
      if (!selectors.has(index)) return [arg];
      if (editorPath(arg, index) !== editor) return [];
      return [editor ? relative(arg).slice('packages/editor/'.length) : arg];
    });
  const runs = [
    {
      cwd: path.join(root, 'packages/editor'),
      args: routedArgs(true),
    },
  ];
  if (args.some(rootPath)) {
    runs.push({ cwd: root, args: routedArgs(false) });
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
