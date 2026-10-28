// The only pipeline schedule is the nightly TestFlight build. GitLab counts
// every `changes:` filter as matched in a scheduled pipeline, so a job that
// forgets the `.not-scheduled` guard silently joins the nightly run. These
// tests evaluate each job's rules the way GitLab does — first matching rule
// wins — for a scheduled run and for a plain main push.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_SCHEMA, defineSequenceTag, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { gitlabCiPaths } from './lib/gitlab-ci.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const schema = CORE_SCHEMA.withTags(
  defineSequenceTag('!reference', {
    create: () => ({ reference: [] }),
    addItem: (carrier, item) => void carrier.reference.push(item),
    identify: () => false,
  }),
);

const config = {};
for (const file of gitlabCiPaths(ROOT)) {
  Object.assign(config, load(readFileSync(join(ROOT, file), 'utf8'), { schema }));
}

const NOT_JOBS = new Set(['default', 'variables', 'workflow', 'stages', 'include']);
const jobNames = Object.keys(config).filter((name) => !NOT_JOBS.has(name) && !name.startsWith('.'));

function rulesOf(job) {
  if (job.rules) return job.rules;
  for (const parent of [job.extends ?? []].flat().reverse()) {
    const inherited = rulesOf(config[parent]);
    if (inherited) return inherited;
  }
  return undefined;
}

function expand(rules) {
  return rules.flatMap((rule) =>
    rule.reference
      ? expand(rule.reference.slice(1).reduce((node, key) => node[key], config[rule.reference[0]]))
      : [rule],
  );
}

// Just enough of GitLab's `rules:if` grammar for this pipeline: `||`, `&&`,
// bare `$VAR`, and `==` / `!=` / `=~` against a variable, a string, or a regex.
function matches(expression, env) {
  const value = (token) =>
    token.startsWith('$') ? (env[token.slice(1)] ?? '') : token.replace(/^"(.*)"$/, '$1');
  return expression.split('||').some((any) =>
    any.split('&&').every((term) => {
      const [left, op, right] = term.trim().split(/\s+(==|!=|=~)\s+/);
      if (!op) return value(left) !== '';
      if (op === '=~') return new RegExp(right.replace(/^\/(.*)\/$/, '$1')).test(value(left));
      return (value(left) === value(right)) === (op === '==');
    }),
  );
}

// What GitLab does with a job: 'never', 'on_success', 'manual', ...
function outcome(job, env) {
  const rules = rulesOf(job);
  if (!rules) return 'on_success';
  // A scheduled pipeline treats every `changes:` as matched; a push in these
  // tests is assumed to touch whatever the filter lists.
  const rule = expand(rules).find((r) => r.if === undefined || matches(r.if, env));
  return rule ? (rule.when ?? 'on_success') : 'never';
}

const MAIN = { CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'main' };
const SCHEDULE = { ...MAIN, CI_PIPELINE_SOURCE: 'schedule' };
const PUSH = { ...MAIN, CI_PIPELINE_SOURCE: 'push' };

describe('the nightly TestFlight schedule', () => {
  it('is admitted by the workflow rules', () => {
    expect(config.workflow.rules.some((rule) => matches(rule.if, SCHEDULE))).toBe(true);
  });

  it('runs only the test gate, the iOS build, and the TestFlight upload', () => {
    const running = jobNames.filter((name) => outcome(config[name], SCHEDULE) !== 'never');
    expect(running.sort()).toEqual(['build:ios-native', 'publish:ios:main', 'test']);
    expect(outcome(config['build:ios-native'], SCHEDULE)).toBe('on_success');
  });
});

describe('a main push', () => {
  it('offers the TestFlight build as a button instead of uploading every push', () => {
    expect(outcome(config['build:ios-native'], PUSH)).toBe('manual');
    expect(rulesOf(config['build:ios-native']).find((r) => r.when === 'manual').allow_failure).toBe(
      true,
    );
    // The upload follows the button press on its own.
    expect(outcome(config['publish:ios:main'], PUSH)).toBe('on_success');
    expect(config['publish:ios:main'].needs).toContainEqual({
      job: 'build:ios-native',
      artifacts: true,
    });
  });

  it('still builds the IPA automatically on a tag', () => {
    expect(
      outcome(config['build:ios-native'], { CI_COMMIT_TAG: 'v1.2.3', CI_PIPELINE_SOURCE: 'push' }),
    ).toBe('on_success');
  });
});
