// Every main push ships a TestFlight build. These tests evaluate the iOS jobs'
// rules the way GitLab does — first matching rule wins — for a main push, a
// UI-started main pipeline and a tag.
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
  const rule = expand(rules).find((r) => r.if === undefined || matches(r.if, env));
  return rule ? (rule.when ?? 'on_success') : 'never';
}

const MAIN = { CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'main' };
const PUSH = { ...MAIN, CI_PIPELINE_SOURCE: 'push' };

describe('a main push', () => {
  it('builds and uploads a TestFlight build on every push', () => {
    expect(outcome(config['build:ios-native'], PUSH)).toBe('on_success');
    expect(outcome(config['publish:ios:main'], PUSH)).toBe('on_success');
    expect(config['publish:ios:main'].needs).toContainEqual({
      job: 'build:ios-native',
      artifacts: true,
    });
  });

  it('offers the build as a button on a main pipeline started from the UI', () => {
    expect(outcome(config['build:ios-native'], { ...MAIN, CI_PIPELINE_SOURCE: 'web' })).toBe(
      'manual',
    );
  });

  it('still builds the IPA automatically on a tag', () => {
    expect(
      outcome(config['build:ios-native'], { CI_COMMIT_TAG: 'v1.2.3', CI_PIPELINE_SOURCE: 'push' }),
    ).toBe('on_success');
    // A tag uploads through publish:ios, never the main job.
    const tag = { CI_COMMIT_TAG: 'v1.2.3', CI_DEFAULT_BRANCH: 'main', CI_PIPELINE_SOURCE: 'push' };
    expect(outcome(config['publish:ios:main'], tag)).toBe('never');
  });
});
