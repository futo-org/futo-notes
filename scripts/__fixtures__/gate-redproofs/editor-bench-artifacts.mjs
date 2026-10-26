// Build-free boundary fixture for the real benchmark gate. Only subprocesses,
// filesystem IO and process exit are substituted; the gate's policy runs intact.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { playwrightArtifacts } from '../../playwright-artifacts.mjs';

export function runEditorBenchGateFixture({ fail = false, crash = false } = {}) {
  const reportFile = playwrightArtifacts('editor-embed', 'editor-embed-results.json').jsonReport;
  const report = (failed) =>
    JSON.stringify({
      suites: [
        {
          specs: Array.from({ length: 650 }, (_, index) => ({
            file: 'fixture.spec.ts',
            title: index === 0 ? 'redproof-artifact-failure' : `case ${index}`,
            tests: [{ status: failed && index === 0 ? 'unexpected' : 'expected' }],
          })),
        },
      ],
    });
  const summary = (median) =>
    JSON.stringify({
      summary: {
        probe: Object.fromEntries(
          ['styledElements', 'layoutScope', 'jsCalls'].map((key) => [key, { median }]),
        ),
      },
    });
  const files = new Map([
    ['docs/perf/editor-bench-baseline.json', summary(100)],
    ['scripts/perf/editor-bench-gate-known-failures.json', JSON.stringify({ failures: [] })],
    ['test-results/editor-embed-results.json', report(false)],
    [reportFile, report(false)],
  ]);
  const output = [];
  const exit = {};
  const context = {
    path,
    playwrightArtifacts,
    performance,
    tmpdir: () => '/fixture',
    mkdtempSync: () => '/fixture/bench',
    copyFileSync: () => {
      throw new Error('fixture must not accept baseline writes');
    },
    readFileSync: (file) => {
      if (!files.has(file)) throw new Error(`missing ${file}`);
      return files.get(file);
    },
    rmSync: (file) => files.delete(file),
    spawnSync: (command, args) => {
      if (command !== 'pnpm') {
        files.set(args[args.indexOf('--json') + 1], summary(90));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (!crash) files.set(reportFile, report(fail));
      return {
        status: fail || crash ? 1 : 0,
        stdout: '',
        stderr: crash ? 'fixture child crashed' : '',
      };
    },
    process: {
      argv: ['node', 'editor-bench-gate'],
      execPath: process.execPath,
      env: process.env,
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => output.push(text) },
      exit: (code) => {
        exit.code = code;
        throw exit;
      },
    },
    console: {
      log: (...args) => output.push(args.join(' ')),
      error: (...args) => output.push(args.join(' ')),
    },
  };
  // Imports are injected above so this executes the actual entire gate while
  // avoiding its expensive browser/build subprocesses and real artifact writes.
  const source = readFileSync(new URL('../../perf/editor-bench-gate.mjs', import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '')
    .replace(/^import .*;\n/gm, '');
  try {
    vm.runInNewContext(source, context, { timeout: 1000 });
    throw new Error('gate did not exit');
  } catch (error) {
    if (error !== exit) throw error;
  }
  return { code: exit.code, output: output.join('\n') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.PW_RUN_ID = 'redproof';
  delete process.env.FUTO_VERIFICATION_DIR;
  const result = runEditorBenchGateFixture({
    fail: existsSync('scripts/__fixtures__/gate-redproofs/editor-bench-violation'),
    crash: existsSync('scripts/__fixtures__/gate-redproofs/editor-bench-crash'),
  });
  console.log(result.output);
  process.exit(result.code);
}
