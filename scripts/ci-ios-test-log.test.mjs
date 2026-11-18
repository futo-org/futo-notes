import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = new URL('./ci-ios-test-log.sh', import.meta.url).pathname;

function run(args, { input, env } = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// What xcodebuild prints for a passing run, in the lines the arbiter reads.
const PASSING = [
  "Test Suite 'FutoNotesNativeTests.xctest' passed at 2026-11-18 10:00:00.000.",
  '\t Executed 0 tests, with 0 failures (0 unexpected) in 0.001 (0.002) seconds',
  '✔ Test run with 268 tests in 41 suites passed after 3.2 seconds.',
  "Test Suite 'AppStorePurchaseTests' passed at 2026-11-18 10:01:00.000.",
  "Test Suite 'FutoNotesNativeUITests.xctest' passed at 2026-11-18 10:01:00.000.",
  '\t Executed 5 tests, with 0 failures (0 unexpected) in 98.0 (98.1) seconds',
  '** TEST SUCCEEDED **',
];

function verdict(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'ios-test-log-'));
  writeFileSync(
    join(dir, 'AppStorePurchaseTests.swift'),
    'final class AppStorePurchaseTests: XCTestCase {}\n',
  );
  const log = join(dir, 'xcodebuild-test.log');
  writeFileSync(log, `${lines.join('\n')}\n`);
  return run(['verdict', log], { env: { UITESTS_DIR: dir } });
}

describe('ci-ios-test-log.sh filter', () => {
  it('drops the keyboard renderer chatter and keeps every other line', () => {
    const noise =
      '2026-11-18 10:00:00.000 FutoNotesNative[1:2] [UIKBRenderingLog] keyboardVerticalSizeClass may only be set';
    const out = run(['filter'], { input: `${noise}\n${PASSING.join('\n')}\n${noise}\n` });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`${PASSING.join('\n')}\n`);
  });

  it('succeeds on input that is all noise', () => {
    const out = run(['filter'], { input: '[UIKBRenderingLog] a\n[UIKBRenderingLog] b\n' });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('');
  });
});

describe('ci-ios-test-log.sh verdict', () => {
  it('passes a log where both bundles passed', () => {
    const out = verdict(PASSING);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/unit bundle: .*268 tests/);
    expect(out.stdout).toMatch(/UI bundle: 5 test/);
    expect(out.stdout).toMatch(/iOS tests passed/);
  });

  it('fails on a failed Swift Testing run and says which tests', () => {
    const out = verdict([
      ...PASSING.slice(0, 2),
      '✘ Test "buying owns it" failed after 0.001 seconds with 1 issue.',
      '✘ Test run with 268 tests in 41 suites failed after 3.2 seconds with 1 issue.',
      '** TEST FAILED **',
    ]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/xcodebuild reported test\/build failures/);
    expect(out.stderr).toMatch(/buying owns it/);
  });

  it('fails on a failed UI case', () => {
    const out = verdict(
      PASSING.map((l) =>
        l.replace('Executed 5 tests, with 0 failures', 'Executed 5 tests, with 1 failure'),
      ),
    );
    expect(out.status).toBe(1);
  });

  it('does not let the empty XCTest half stand in for the unit bundle', () => {
    const out = verdict(PASSING.filter((l) => !l.includes('Test run with')));
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/no passing Swift Testing summary/);
  });

  it('fails when the UI suite never ran', () => {
    const out = verdict(PASSING.filter((l) => !l.includes('UITests')));
    expect(out.status).toBe(1);
  });

  it('fails without the overall success marker', () => {
    const out = verdict(PASSING.filter((l) => !l.includes('TEST SUCCEEDED')));
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/TEST SUCCEEDED/);
  });

  it('fails on a missing or empty log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ios-test-log-'));
    writeFileSync(join(dir, 'empty.log'), '');
    expect(run(['verdict', join(dir, 'empty.log')]).status).toBe(1);
    expect(run(['verdict', join(dir, 'absent.log')]).status).toBe(1);
  });
});
