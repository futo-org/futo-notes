import { readFileSync } from 'node:fs';

import { CORE_SCHEMA, defineSequenceTag, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  justfileSources,
  gitlabPipeline,
  gitlabPipelineSources,
  packageScripts,
  androidInstrumentationScript,
  androidEmulatorScript,
  topLevelBlock,
} from './premerge-test-parity.helpers.mjs';

const gitlabYamlSchema = CORE_SCHEMA.withTags(
  defineSequenceTag('!reference', {
    create: () => [],
    addItem: (carrier, item) => void carrier.push(item),
    identify: () => false,
  }),
);

describe('pre-merge CI routing contracts', () => {
  it('has no duplicate mapping keys in any pipeline file', () => {
    // GitLab keeps the last of two same-named keys without a warning: a stale
    // second `changes:` once replaced main's sync-suite path list.
    for (const [file, source] of Object.entries(gitlabPipelineSources)) {
      expect(() => load(source, { schema: gitlabYamlSchema, filename: file })).not.toThrow();
    }
  });

  it('provisions missing Cirrus tools in every Mac runner shell', () => {
    const jobs = gitlabPipeline.split(/(?=^[^ #\n][^\n]*:\n)/m);
    const cirrusJobs = jobs.filter((job) => job.includes('    - cirrus run '));
    expect(cirrusJobs).toHaveLength(8);
    for (const job of cirrusJobs) {
      expect(job).toContain('    - export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"');
      expect(job).toContain('command -v cirrus || brew install cirruslabs/cli/cirrus');
      expect(job.indexOf('export PATH=')).toBeLessThan(job.indexOf('    - cirrus run '));
    }
  });

  it('runs the P0 spec inside test:e2e:rest, not as a second CI job', () => {
    // The quick local script stays, but CI has one job for the whole suite, so
    // nothing may exclude the spec from it or re-add a standalone job.
    expect(packageScripts['test:e2e:smoke']).toBe('playwright test tests/p0-regressions.spec.ts');
    expect(packageScripts['test:e2e:rest']).not.toContain('--grep-invert');
    expect(gitlabPipeline).not.toMatch(/^test:e2e:smoke:/m);
    expect(topLevelBlock(gitlabPipeline, /^release:gate:$/m)).not.toContain('test:e2e:smoke');
  });

  it('proves every Playwright shard ran as its shard and ran tests', () => {
    // Both failures are green on their own: `pnpm run <script> -- --shard=…`
    // ran the whole suite in every shard, and an empty shard exits 0. The
    // runtime check catches both, but cannot catch its own absence.
    const jobs = gitlabPipeline.split(/(?=^[^ #\n][^\n]*:\n)/m);
    const sharded = jobs.filter(
      (job) => /^ {2}parallel: \d+$/m.test(job) && job.includes('pnpm run test:e2e'),
    );
    expect(sharded.length).toBeGreaterThan(0);
    for (const job of sharded) {
      const name = job.split('\n')[0];
      expect(job, name).toContain('!reference [.check-playwright-shard, script]');
      expect(job, name).toMatch(
        /^ {4}PLAYWRIGHT_JSON: \$CI_PROJECT_DIR\/test-results\/\S+\.json$/m,
      );
    }
    expect(packageScripts['test:e2e:rest']).toContain('--workers=2');
  });

  it('puts only short script-only jobs on the light runner tag, never an image or build job', () => {
    // Runner 71 takes $LIGHT_RUNNER_TAG (dind_fast); under load it ran heavy jobs
    // 4-18x slower than 112, so every heavy job stays on $LINUX_RUNNER_TAG.
    expect(gitlabPipeline).toMatch(/^ {2}LIGHT_RUNNER_TAG: dind_fast$/m);
    for (const name of [
      'check:release-notes',
      'test:audit',
      'test:localization-audit',
      'test:puppet-gates',
    ]) {
      const job = topLevelBlock(gitlabPipeline, new RegExp(`^${name}:$`, 'm'));
      expect(job, name).toMatch(/^ {2}tags:\n {4}- \$LIGHT_RUNNER_TAG$/m);
      expect(job, name).not.toContain('extends:');
    }
    for (const name of ['test', 'test:rust:workspace', 'test:e2e:rest', 'build:android-native']) {
      const job = topLevelBlock(gitlabPipeline, new RegExp(`^${name}:$`, 'm'));
      expect(job, name).not.toContain('LIGHT_RUNNER_TAG');
    }
  });

  it('keeps every Rust cache on one main key that only main and tags write', () => {
    const templates = readFileSync(new URL('../ci/templates.yml', import.meta.url), 'utf8');
    expect(templates).not.toContain('CI_COMMIT_REF_SLUG');
    for (const name of ['cargo-tauri', 'native']) {
      expect(templates).toContain(`key: ${name}-$CARGO_CACHE_EPOCH-$CI_DEFAULT_BRANCH`);
    }
  });

  it('does not cancel manual image rebuilds when a newer pipeline starts', () => {
    const androidImageJob = topLevelBlock(gitlabPipeline, /^build:ci-android-image:$/m);
    const testImageJob = topLevelBlock(gitlabPipeline, /^build:ci-test-image:$/m);

    expect(androidImageJob).toContain('interruptible: false');
    expect(testImageJob).toContain('interruptible: false');
  });

  it('publishes stores and package repos only from stable tags', () => {
    const stableTag = 'if: $CI_COMMIT_TAG =~ /^v[0-9]+\\.[0-9]+\\.[0-9]+$/';
    for (const jobName of [
      /^publish:ios:$/m,
      /^publish:android:$/m,
      /^release:$/m,
      /^update-fdroid:$/m,
      /^pkg-futoinfra:prep:$/m,
      /^pkg-futoinfra:trigger:$/m,
    ]) {
      expect(topLevelBlock(gitlabPipeline, jobName)).toContain(stableTag);
    }
  });

  // RC-65: GitLab and the CI scripts run with pipefail. `producer | grep -q`
  // exits on the first match and SIGPIPEs a producer that still has output to
  // write (141), so the pipeline reads as failed on a true condition. It made
  // the Android JVM-unit-test guard fire falsely on MR !359 (59 result files).
  // Only a producer that emits one small buffer (echo/printf of a short value)
  // is safe; anything else must be pipe-free or consume all input.
  it('has no early-exit `| grep -q` consumer of a multi-buffer producer under pipefail', () => {
    const sources = {
      ...gitlabPipelineSources,
      ...justfileSources,
      'scripts/ci-android-instrumentation.sh': androidInstrumentationScript,
      'scripts/ci-android-emulator.sh': androidEmulatorScript,
    };
    const earlyExitGrep =
      /\|\s*(?:grep|egrep|fgrep|rg)\b[^|\n]*?(?:\s-[a-zA-Z]*q|--quiet|--silent)/;
    /\|\s*(?:grep|egrep|fgrep|rg)\s[^|\n]*?(?:\s-[a-zA-Z]*q|--quiet|--silent)/;
    const smallProducer = /(?:\becho|\bprintf|simctl list devices booted)\b[^|\n]*\|/;
    const offenders = [];
    for (const [file, text] of Object.entries(sources)) {
      text.split('\n').forEach((line, i) => {
        if (!line.trim().startsWith('#') && earlyExitGrep.test(line) && !smallProducer.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('checks the Android JVM unit-test XML without a find | grep pipe', () => {
    const androidJob = topLevelBlock(gitlabPipeline, /^build:android-native:$/m);
    expect(androidJob).toContain("-name 'TEST-*.xml' -type f -print -quit");
  });

  it('keeps CI free of jobs that need a host to themselves', () => {
    // The cross-device sync e2e suites flaked when two runs shared a host and
    // were pinned to a one-job-at-a-time runner; they run by hand now
    // (`pnpm run test:cross-platform`). Jobs must be able to overlap.
    expect(gitlabPipeline).not.toContain('futo_notes_serial');
    expect(gitlabPipeline).not.toMatch(/^\s+resource_group: (?!ios-)/m);
    expect(gitlabPipeline).not.toMatch(/^test:cross-platform-sync/m);
    const releaseGate = topLevelBlock(gitlabPipeline, /^release:gate:$/m);
    expect(releaseGate).not.toContain('test:cross-platform-sync');
    const ffiJob = topLevelBlock(gitlabPipeline, /^test:rust:ffi-android:$/m);
    expect(ffiJob).toContain('    - $LINUX_RUNNER_TAG');
    expect(ffiJob).not.toContain('resource_group');
  });

  it('runs the Windows Rust tests on crate changes behind the bring-up switch', () => {
    const win = topLevelBlock(gitlabPipeline, /^test:rust:windows:$/m);
    const releaseGate = topLevelBlock(gitlabPipeline, /^release:gate:$/m);

    expect(win).toContain('    - windows_persist');
    // PowerShell shell: the bash default before_script must not run.
    expect(win).toContain('before_script: []');
    expect(win).toContain('cargo test --workspace --locked');
    expect(win).toMatch(/- if: \$WINDOWS_PERSIST_RUNNER != "1"\n {6}when: never/);
    expect(win).toContain('        - crates/**/*');
    expect(releaseGate).toMatch(/- job: test:rust:windows\n {6}optional: true/);
  });

  it('sends every Linux job to the office runners through one variable', () => {
    expect(gitlabPipeline).toMatch(
      /^default:\n(?: {2}#.*\n)* {2}tags:\n {4}- \$LINUX_RUNNER_TAG$/m,
    );
    expect(gitlabPipeline).toContain('LINUX_RUNNER_TAG: futo_notes_debian1');
    // No job names a Linux runner tag directly; the outage path (runner 55)
    // is a run-pipeline variable, not an edit.
    expect(gitlabPipeline).not.toMatch(/^ {4}- dind(_fast)?$/m);
  });
  it('uploads stable-tag iOS builds to TestFlight before the gate, but submits after it', () => {
    const upload = topLevelBlock(gitlabPipeline, /^publish:ios:$/m);
    const submit = topLevelBlock(gitlabPipeline, /^publish:ios:appstore:$/m);
    const releaseGate = topLevelBlock(gitlabPipeline, /^release:gate:$/m);
    // Apple's processing overlaps the tests; only App Store review waits.
    expect(upload).not.toContain('job: release:gate');
    expect(upload).toContain('    - job: build:ios-native\n');
    expect(upload).toContain('resource_group: ios-testflight');
    expect(submit).toContain('    - job: release:gate\n');
    expect(submit).toContain('    - job: publish:ios\n');
    // A publish job in the gate would make an Apple outage block every store.
    expect(releaseGate).not.toContain('job: publish:ios');
  });
});
