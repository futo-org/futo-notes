/**
 * What the harness scripts share. The withheld regression test is the answer
 * key: the builder's red-proof and the grader's green-check have to restore and
 * run it exactly the same way or they are not measuring the same thing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** How the owning layer runs one test file. */
export function testCommand(path) {
  if (path.startsWith('tests/') && path.endsWith('.spec.ts'))
    return ['pnpm', ['exec', 'playwright', 'test', path]];
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return ['node_modules/.bin/vitest', ['run', path]];
  if (path.startsWith('crates/')) return ['cargo', ['test', '-p', path.split('/')[1]]];
  if (path.startsWith('apps/android/'))
    return ['./gradlew', [':app:testDebugUnitTest'], 'apps/android'];
  if (path.startsWith('apps/ios/')) return ['just', ['test-ios-native']];
  return null;
}

export function runCommand(command, args, cwd) {
  try {
    execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 20 * 60_000 });
    return { passed: true, output: '' };
  } catch (error) {
    return { passed: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.slice(-4000) };
  }
}

/**
 * Drop the fix's version of every withheld test into the tree, run each, and
 * put the tree back exactly as it was — including deleting files that the fix
 * ADDED and the scenario therefore does not have.
 */
export function runWithheldTests(repoDir, answerDir, withheldTests) {
  const results = [];
  for (const path of withheldTests) {
    const full = join(repoDir, path);
    const existed = existsSync(full);
    const before = existed ? readFileSync(full, 'utf8') : null;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, readFileSync(join(answerDir, path.replaceAll('/', '__')), 'utf8'));

    const command = testCommand(path);
    results.push({
      path,
      ...(command
        ? runCommand(command[0], command[1], command[2] ? join(repoDir, command[2]) : repoDir)
        : { passed: null, output: 'no runner mapped for this path' }),
    });

    if (existed) writeFileSync(full, before);
    else rmSync(full, { force: true });
  }
  return results;
}

/**
 * Where a scenario actually landed. The builder may have suffixed the directory
 * to move it off a slot another checkout already owns, so the name is not
 * simply `<id>--<arm>`.
 */
export function scenarioDir(workRoot, id, arm) {
  const pattern = new RegExp(`^${id}--${arm}(-\\d+)?$`);
  const match = readdirSync(workRoot).find((entry) => pattern.test(entry));
  if (!match) throw new Error(`not built: run build-scenario.mjs ${id} --arm ${arm}`);
  return join(workRoot, match);
}

/**
 * A logged-out `claude` answers every prompt "Not logged in" at $0, which scores as a failed goal:
 * stop the batch instead, so a sign-in lapse never reads as a result (an iOS smoke "0/5", 2026-10-09).
 */
export function stopIfLoggedOut(streamJson) {
  const loggedOut = streamJson
    .split('\n')
    .some(
      (line) =>
        line.includes('authentication_failed') &&
        JSON.parse(line).error === 'authentication_failed',
    );
  if (loggedOut) throw new Error('claude is not logged in: run `claude auth login`, then re-run');
}
