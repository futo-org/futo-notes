import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  justfileSources,
  gitlabPipeline,
  gitlabPipelineSources,
  packageScripts,
  androidInstrumentationScript,
  androidEmulatorScript,
  androidSyncLegScript,
  topLevelBlock,
  ROOT,
} from './premerge-test-parity.helpers.mjs';

describe('pre-merge CI routing contracts', () => {
  it('keeps the internal Windows VM chain together when its build script changes', () => {
    // A ci/win-build.ps1-only MR previously included the build without its
    // provision job, so GitLab rejected the entire pipeline before any job ran.
    for (const name of [
      'windows:provision:internal',
      'build:desktop-internal:windows',
      'windows:cleanup:internal',
    ]) {
      const block = topLevelBlock(gitlabPipeline, new RegExp(`^${name}:$`, 'm'));
      const mrRule = block.slice(block.lastIndexOf('    - if: $CI_MERGE_REQUEST_IID'));
      expect(mrRule).toContain('      changes:');
      expect(mrRule).toContain('        - ci/win-build.ps1');
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

  it('does not repeat P0 smoke coverage in the remaining Playwright suite', () => {
    // test:e2e:rest skips the smoke spec by describe title, so a test or
    // describe opened beside that describe (column 0 under Prettier) instead
    // of inside it runs in both jobs.
    const smokeSpec = 'tests/p0-regressions.spec.ts';
    expect(packageScripts['test:e2e:smoke']).toBe(`playwright test ${smokeSpec}`);
    const grepInvert = /--grep-invert "([^"]+)"/.exec(packageScripts['test:e2e:rest'])?.[1];
    expect(grepInvert).toBe('P0 Crash and IME Regressions');
    const topLevel = readFileSync(join(ROOT, smokeSpec), 'utf8').match(/^test\b.*$/gm);
    expect(topLevel).toEqual([`test.describe('${grepInvert}', () => {`]);
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

  it('does not recompress the shared Rust target cache after source-only MR jobs', () => {
    const rustWorkspaceJob = topLevelBlock(gitlabPipeline, /^test:rust:workspace:$/m);
    const syncJob = topLevelBlock(gitlabPipeline, /^test:cross-platform-sync:$/m);

    expect(rustWorkspaceJob).toContain('CARGO_CACHE_POLICY: pull');
    expect(rustWorkspaceJob).toContain('- dind_fast');
    expect(rustWorkspaceJob).toContain('needs: []');
    expect(syncJob).toMatch(/^\s{4}CARGO_CACHE_POLICY: pull$/m);
    expect(syncJob).toContain('CARGO_CACHE_POLICY: pull-push');
    expect(syncJob).toContain('.cache-cargo-sync');
    expect(syncJob).toContain('needs: []');
    expect(rustWorkspaceJob).toContain('Cargo.lock');
    expect(rustWorkspaceJob).toContain('CARGO_CACHE_POLICY: pull-push');
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

  it('runs the editor-bundle MR jobs for every directory in the bundle import graph', () => {
    const bundleInputs = [
      'src/editor-embed/**/*',
      'src/features/editor/**/*',
      'src/styles/**/*',
      'src/features/images/**/*',
      'packages/editor/**/*',
      'editor.html',
      'vite.editor.config.ts',
      'src/lib/platform/**/*',
      'src/lib/localNoteStore.ts',
      'src/lib/rules.ts',
      'src/shared/**/*',
      'src/features/sync/**/*',
      'src/features/notes/**/*',
      'src/features/folders/**/*',
      'svelte.config.js',
    ];
    for (const jobName of [/^test:e2e:editor-embed:$/m, /^test:ios-native:$/m]) {
      const job = topLevelBlock(gitlabPipeline, jobName);
      const mrRule = job.slice(job.indexOf('$CI_MERGE_REQUEST_IID'));
      const changes = mrRule.slice(mrRule.indexOf('changes:'), mrRule.indexOf('- if:'));
      for (const glob of bundleInputs) {
        expect(changes, `${jobName} MR changes: is missing ${glob}`).toContain(`- ${glob}\n`);
      }
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
      'scripts/ci-android-sync-leg.sh': androidSyncLegScript,
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

  it('skips slow sync scenarios only on MR pipelines, never on main or tags', () => {
    const syncJob = topLevelBlock(gitlabPipeline, /^test:cross-platform-sync:$/m);

    expect(syncJob).toContain('node tests/cross-platform-sync.mjs $SYNC_SCENARIO_FLAGS');
    // Exactly the two auto-run MR rules (lockfile, sync-critical) set the
    // flag; the tag, default-branch, and manual rules run the full set.
    expect(syncJob.match(/SYNC_SCENARIO_FLAGS: --skip-slow/g)).toHaveLength(2);
    expect(syncJob).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
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
