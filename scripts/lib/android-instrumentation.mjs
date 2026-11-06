// Pure halves of the Android instrumentation runner (scripts/android-instrument.mjs):
// test selectors, `am instrument -r` output and Gradle JUnit XML, and the M11
// verdict both paths share. No device access here, so all of it is unit-tested.
import fs from 'node:fs';
import path from 'node:path';

// ── selectors ───────────────────────────────────────────────────────────────

// A class's simple name starts upper-case and a package segment lower-case, by
// the Java convention every test in this module follows.
const CLASS_RE = /^(?:[a-z_$][A-Za-z0-9_$]*\.)+[A-Z][A-Za-z0-9_$]*(?:#[A-Za-z_$][A-Za-z0-9_$]*)?$/;
const PACKAGE_RE = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+$/;

export function parseSelectors(list) {
  const selectors = [];
  for (const raw of list) {
    // Accept a comma list too, since that is what -e class takes.
    for (const value of raw.split(',').filter(Boolean)) {
      if (CLASS_RE.test(value)) {
        const [cls, method] = value.split('#');
        selectors.push({ kind: method ? 'method' : 'class', value, cls, method });
      } else if (PACKAGE_RE.test(value)) {
        selectors.push({ kind: 'package', value });
      } else {
        throw new Error(
          `not a fully qualified test class, Class#method or package: ${JSON.stringify(value)}`,
        );
      }
    }
  }
  const values = selectors.map((s) => s.value);
  if (new Set(values).size !== values.length) throw new Error('a selector is repeated');
  const packages = selectors.filter((s) => s.kind === 'package');
  if (packages.length && packages.length !== selectors.length)
    throw new Error('mix of packages and classes: the runner cannot combine them; run two calls');
  return selectors;
}

export function runnerArgs(selectors, { shard, extra = [] } = {}) {
  const args = [];
  const classes = selectors.filter((s) => s.kind !== 'package').map((s) => s.value);
  const packages = selectors.filter((s) => s.kind === 'package').map((s) => s.value);
  if (classes.length) args.push('-e', 'class', classes.join(','));
  if (packages.length) args.push('-e', 'package', packages.join(','));
  if (shard && shard.count > 1)
    args.push('-e', 'numShards', String(shard.count), '-e', 'shardIndex', String(shard.index));
  for (const [key, value] of extra) args.push('-e', key, value);
  return args;
}

// ── instrumentation output ─────────────────────────────────────────────────

// Status codes AndroidJUnitRunner reports with `am instrument -r`.
const START = 1;
const OK = 0;
const ERROR = -1;
const FAILURE = -2;
const IGNORED = -3;
const ASSUMPTION = -4;
const OUTCOME = {
  [OK]: 'pass',
  [ERROR]: 'fail',
  [FAILURE]: 'fail',
  [IGNORED]: 'skip',
  [ASSUMPTION]: 'skip',
};

// Parse raw `am instrument -w -r` output. Values (stack, stream) run over several
// lines: every line up to the next INSTRUMENTATION_ prefix belongs to the key above.
export function parseInstrumentation(output, onTest = () => {}) {
  const lines = output.replaceAll('\r', '').split('\n');
  const tests = [];
  let status = {};
  let result = {};
  let current; // [object, key]
  let started;
  let numtests;
  let code;
  const failed = [];
  for (const line of lines) {
    let m;
    if ((m = line.match(/^INSTRUMENTATION_STATUS: ([^=]+)=(.*)$/))) {
      status[m[1]] = m[2];
      current = [status, m[1]];
    } else if ((m = line.match(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)$/))) {
      const statusCode = Number(m[1]);
      if (status.numtests !== undefined) numtests = Number(status.numtests);
      if (statusCode === START) {
        if (started)
          failed.push(`${started.cls}#${started.test} started a new test before finishing`);
        started = { cls: status.class, test: status.test };
      } else if (statusCode in OUTCOME) {
        const test = {
          cls: status.class,
          test: status.test,
          outcome: OUTCOME[statusCode],
          stack: status.stack?.trim(),
        };
        if (started && started.cls === test.cls && started.test === test.test) started = undefined;
        tests.push(test);
        onTest(test);
      }
      status = {};
      current = undefined;
    } else if ((m = line.match(/^INSTRUMENTATION_RESULT: ([^=]+)=(.*)$/))) {
      result[m[1]] = m[2];
      current = [result, m[1]];
    } else if ((m = line.match(/^INSTRUMENTATION_CODE: (-?\d+)$/))) {
      code = Number(m[1]);
      current = undefined;
    } else if ((m = line.match(/^INSTRUMENTATION_(FAILED|ABORTED): ?(.*)$/))) {
      result.shortMsg ??= `INSTRUMENTATION_${m[1]}: ${m[2]}`;
      current = undefined;
    } else if (current) {
      current[0][current[1]] += `\n${line}`;
    }
  }
  // A test that started and never reported an outcome is where the process died.
  return { tests, numtests, code, result, unfinished: started, problems: failed };
}

export const label = (t) => `${t.cls}#${t.test}`;
const methodMatches = (t, sel) =>
  t.cls === sel.cls && (t.test === sel.method || t.test?.startsWith(`${sel.method}[`));

// Merge one parsed run per device (or shard) into a verdict. Pure, so the M11
// rules are unit-tested without a device.
export function assess(selectors, runs) {
  const problems = [];
  const tests = runs.flatMap((r) => r.parsed.tests);
  for (const { serial, parsed, exit, timedOut } of runs) {
    const where = runs.length > 1 ? `${serial}: ` : '';
    problems.push(...parsed.problems.map((p) => where + p));
    if (timedOut) problems.push(`${where}timed out`);
    if (parsed.unfinished)
      problems.push(
        `${where}${label(parsed.unfinished)} started and never finished (process died?)`,
      );
    if (parsed.result.shortMsg)
      problems.push(`${where}instrumentation reported: ${parsed.result.shortMsg.trim()}`);
    if (parsed.code === undefined)
      problems.push(`${where}instrumentation did not finish (no INSTRUMENTATION_CODE)`);
    else if (parsed.code !== -1)
      problems.push(`${where}instrumentation exited with code ${parsed.code}`);
    if (exit !== 0 && exit !== undefined) problems.push(`${where}adb exited ${exit}`);
    const seen = parsed.tests.length;
    if (parsed.numtests !== undefined && parsed.numtests !== seen)
      problems.push(`${where}runner planned ${parsed.numtests} tests but reported ${seen}`);
  }
  if (!tests.length) problems.push('zero tests ran');
  for (const sel of selectors) {
    const hit =
      sel.kind === 'package'
        ? tests.some((t) => t.cls?.startsWith(`${sel.value}.`))
        : sel.kind === 'class'
          ? tests.some((t) => t.cls === sel.cls)
          : tests.some((t) => methodMatches(t, sel));
    if (!hit) problems.push(`selector ran no test: ${sel.value}`);
  }
  const failed = tests.filter((t) => t.outcome === 'fail');
  for (const t of failed) problems.push(`FAILED ${label(t)}`);
  const count = (o) => tests.filter((t) => t.outcome === o).length;
  return {
    ok: problems.length === 0,
    problems,
    failed,
    totals: { tests: tests.length, pass: count('pass'), fail: count('fail'), skip: count('skip') },
  };
}

// ── the Gradle path (`just test-android-native-ui`) ────────────────────────

// AGP 9 runs connected tests through its built-in android-test-engine, which
// receives every runner argument in ONE system property,
// `android-test.instrumentation-args=class=A,B`, and parses it by splitting on
// `,` and then `=`, keeping only key=value pairs. So `class=A,B` became
// `class=A` plus a bare `B` that it dropped without a word: several classes ran
// only the first, and the task still passed. A value can carry no comma (or
// `=`). Several selectors therefore go as one `tests_regex` alternation, which
// needs neither. The engine pastes arguments into an unquoted `adb shell`
// command line, so the regex travels in single quotes; if that ever changes,
// the JUnit check below fails the run rather than letting it pass smaller.
const regexEscape = (text) => text.replace(/[.$]/g, (c) => `[${c}]`);
export function gradleSelectorArg(selectors) {
  const prefix = '-Pandroid.testInstrumentationRunnerArguments.';
  if (!selectors.length) return [];
  if (selectors.length === 1) {
    const [sel] = selectors;
    return [`${prefix}${sel.kind === 'package' ? 'package' : 'class'}=${sel.value}`];
  }
  const alternatives = selectors.map((sel) =>
    sel.kind === 'package'
      ? `${regexEscape(sel.value)}[.]`
      : sel.kind === 'class'
        ? `${regexEscape(sel.cls)}#`
        : `${regexEscape(sel.cls)}#${regexEscape(sel.method)}(\\[.*\\])?$`,
  );
  return [`${prefix}tests_regex='^(${alternatives.join('|')})'`];
}

// The Gradle task can pass with tests missing (the comma bug above; a shell
// error in its command line also ran zero tests and passed), so its JUnit XML
// is checked with the same rules as an `am instrument` run.
export function junitTests(xml) {
  const tests = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (name) => m[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const body = m[3] ?? '';
    tests.push({
      cls: attr('classname'),
      test: attr('name'),
      outcome: /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass',
    });
  }
  return tests;
}

export function checkJunit(dir, selectors) {
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true }).filter((f) => /(^|\/)TEST-[^/]*\.xml$/.test(f))
    : [];
  const tests = files.flatMap((f) => junitTests(fs.readFileSync(path.join(dir, f), 'utf8')));
  const problems = files.length ? [] : [`no JUnit XML under ${dir}`];
  const parsed = { tests, code: -1, result: {}, problems };
  return assess(selectors, [{ serial: 'gradle', exit: 0, parsed }]);
}
