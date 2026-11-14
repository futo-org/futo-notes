import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertEmulator, parseCli, shellQuote } from './android-instrument.mjs';
import {
  assess,
  checkJunit,
  gradleSelectorArg,
  junitTests,
  parseInstrumentation,
  parseSelectors,
  runnerArgs,
} from './lib/android-instrumentation.mjs';

// `am instrument -w -r` output in the shape AndroidJUnitRunner prints it.
const status = (cls, test, code, extra = {}) =>
  [
    `INSTRUMENTATION_STATUS: class=${cls}`,
    'INSTRUMENTATION_STATUS: current=1',
    'INSTRUMENTATION_STATUS: id=AndroidJUnitRunner',
    'INSTRUMENTATION_STATUS: numtests=NUM',
    ...Object.entries(extra).map(([k, v]) => `INSTRUMENTATION_STATUS: ${k}=${v}`),
    'INSTRUMENTATION_STATUS: stream=',
    `${cls}:`,
    `INSTRUMENTATION_STATUS: test=${test}`,
    `INSTRUMENTATION_STATUS_CODE: ${code}`,
  ].join('\r\n');
const run = (
  tests,
  tail = 'INSTRUMENTATION_RESULT: stream=\r\n\r\nOK\r\n\r\nINSTRUMENTATION_CODE: -1',
) =>
  [
    ...tests.flatMap(([cls, test, code = 0, extra]) => [
      status(cls, test, 1),
      status(cls, test, code, extra),
    ]),
    tail,
  ]
    .join('\r\n')
    .replaceAll('NUM', String(tests.length));
const A = 'com.futo.notes.textfirst.TextFirstCaretTest';
const B = 'com.futo.notes.editor.NativeEditorSessionTest';
const verdict = (selectors, output) =>
  assess(parseSelectors(selectors), [
    { serial: 'emulator-5554', exit: 0, parsed: parseInstrumentation(output) },
  ]);

describe('android-instrument selectors', () => {
  it('passes classes and methods as one -e class list, packages as -e package', () => {
    expect(runnerArgs(parseSelectors([A, `${B}#opens`]))).toEqual([
      '-e',
      'class',
      `${A},${B}#opens`,
    ]);
    expect(runnerArgs(parseSelectors(['com.futo.notes.textfirst']))).toEqual([
      '-e',
      'package',
      'com.futo.notes.textfirst',
    ]);
    expect(runnerArgs(parseSelectors([`${A},${B}`]))).toEqual(['-e', 'class', `${A},${B}`]);
  });

  it('adds the shard only when there is more than one', () => {
    expect(runnerArgs([], { shard: { count: 1, index: 0 } })).toEqual([]);
    expect(runnerArgs([], { shard: { count: 3, index: 2 } })).toEqual([
      '-e',
      'numShards',
      '3',
      '-e',
      'shardIndex',
      '2',
    ]);
  });

  it('rejects what the runner would misread', () => {
    expect(() => parseSelectors(['TextFirstCaretTest'])).toThrow(/fully qualified/);
    expect(() => parseSelectors(['--help'])).toThrow(/fully qualified/);
    expect(() => parseSelectors([A, 'com.futo.notes.textfirst'])).toThrow(/mix/);
    expect(() => parseSelectors([A, A])).toThrow(/repeated/);
    expect(() => parseCli(['--arg', 'class=x'])).toThrow(/--arg/);
  });

  it('quotes each argument for the device shell adb hands it to', () => {
    expect(shellQuote(`${A},${B}`)).toBe(`${A},${B}`);
    expect(shellQuote(`${A}#caret`)).toBe(`'${A}#caret'`);
    expect(shellQuote("it's a note; rm x")).toBe(`'it'\\''s a note; rm x'`);
  });

  it('refuses anything but an emulator before asking adb', () => {
    expect(() => assertEmulator('35251JEHN07183', 'futo-qa-1')).toThrow(/never a physical device/);
  });
});

describe('android-instrument on the Gradle path', () => {
  const prefix = '-Pandroid.testInstrumentationRunnerArguments.';

  it('keeps one selector a plain filter', () => {
    expect(gradleSelectorArg([])).toEqual([]);
    expect(gradleSelectorArg(parseSelectors([A]))).toEqual([`${prefix}class=${A}`]);
  });

  // AGP 9's engine splits runner arguments on ',' and '=', so `class=A,B` ran A only.
  it('sends several selectors as one quoted regex with no comma or =', () => {
    const packages = parseSelectors(['com.futo.notes.license', 'com.futo.notes.ui']);
    const [arg] = gradleSelectorArg([...parseSelectors([A, `${B}#opens`]), ...packages]);
    const value = arg.slice(`${prefix}tests_regex=`.length);
    expect(arg.startsWith(`${prefix}tests_regex='`)).toBe(true);
    expect(value).not.toMatch(/[,=]/);
    const regex = new RegExp(value.slice(1, -1));
    for (const name of [
      `${A}#caret`,
      `${B}#opens`,
      `${B}#opens[2]`,
      'com.futo.notes.license.LicenseCopyTest#x',
    ])
      expect(regex.test(name), name).toBe(true);
    for (const name of [`${A}Extra#caret`, `${B}#opensLater`, 'com.futo.notes.licenseX.T#x'])
      expect(regex.test(name), name).toBe(false);
  });

  it('checks Gradle JUnit XML with the same rules', () => {
    const xml = `<testsuite><testcase name="caret" classname="${A}" time="1"/>
      <testcase name="opens" classname="${B}"><failure>boom</failure></testcase></testsuite>`;
    expect(junitTests(xml)).toEqual([
      { cls: A, test: 'caret', outcome: 'pass' },
      { cls: B, test: 'opens', outcome: 'fail' },
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-junit-'));
    try {
      expect(checkJunit(dir, []).problems).toContain(`no JUnit XML under ${dir}`);
      fs.mkdirSync(path.join(dir, 'debug'));
      fs.writeFileSync(
        path.join(dir, 'debug', 'TEST-dev.xml'),
        `<testcase name="caret" classname="${A}"/>`,
      );
      expect(checkJunit(dir, parseSelectors([A])).ok).toBe(true);
      expect(checkJunit(dir, parseSelectors([A, B])).problems).toContain(
        `selector ran no test: ${B}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('android-instrument verdict (M11)', () => {
  it('is green only when every requested class ran and passed', () => {
    const v = verdict(
      [A, B],
      run([
        [A, 'caret'],
        [B, 'opens'],
      ]),
    );
    expect(v.ok, v.problems.join('\n')).toBe(true);
    expect(v.totals).toEqual({ tests: 2, pass: 2, fail: 0, skip: 0 });
  });

  it('is red when a requested class ran nothing (the dropped-class bug)', () => {
    const v = verdict([A, B], run([[A, 'caret']]));
    expect(v.ok).toBe(false);
    expect(v.problems).toContain(`selector ran no test: ${B}`);
  });

  it('is red on zero tests, a failure, or a crash mid-test', () => {
    expect(verdict([], run([])).problems).toContain('zero tests ran');

    const failed = verdict(
      [A],
      run([[A, 'caret', -2, { stack: 'java.lang.AssertionError: boom' }]]),
    );
    expect(failed.ok).toBe(false);
    expect(failed.failed[0].stack).toContain('AssertionError: boom');

    const crashed = verdict(
      [A],
      [
        status(A, 'caret', 1),
        'INSTRUMENTATION_RESULT: shortMsg=Process crashed.',
        'INSTRUMENTATION_CODE: 0',
      ]
        .join('\n')
        .replace('NUM', '1'),
    );
    expect(crashed.ok).toBe(false);
    expect(crashed.problems.join('\n')).toMatch(/never finished/);
    expect(crashed.problems.join('\n')).toMatch(/Process crashed/);
  });

  it('is red when the output stops without a result', () => {
    expect(verdict([A], status(A, 'caret', 1)).problems.join('\n')).toMatch(/did not finish/);
  });

  it('counts skips without failing and matches parameterized method names', () => {
    const v = verdict(
      [`${A}#caret`],
      run([
        [A, 'caret[0]'],
        [A, 'caret[1]', -4],
      ]),
    );
    expect(v.ok, v.problems.join('\n')).toBe(true);
    expect(v.totals.skip).toBe(1);
  });

  it('merges shards: a class need only run on one of them', () => {
    const shard = (tests) => ({
      serial: 'emulator-1',
      exit: 0,
      parsed: parseInstrumentation(run(tests)),
    });
    const v = assess(parseSelectors([A, B]), [
      shard([[A, 'caret']]),
      shard([[B, 'opens']]),
      shard([]),
    ]);
    expect(v.ok, v.problems.join('\n')).toBe(true);
  });
});
