import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');
const gitlabPipeline = readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf8');
const packageScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
const cirrusTasks = readFileSync(join(ROOT, '.cirrus.yml'), 'utf8');

function topLevelBlock(contents, startPattern) {
  const match = startPattern.exec(contents);
  if (match?.index == null) throw new Error(`Missing operational entry point: ${startPattern}`);

  const blockStart = match.index;
  const remainingContents = contents.slice(blockStart + match[0].length);
  const nextBlockOffset = remainingContents.search(/^\S[^\n]*:\s*(?:#.*)?$/m);

  return nextBlockOffset === -1
    ? contents.slice(blockStart)
    : contents.slice(blockStart, blockStart + match[0].length + nextBlockOffset);
}

describe('pre-merge JavaScript test routing', () => {
  it('runs the full suite from just check', () => {
    const checkRecipe = topLevelBlock(justfile, /^check:[^\n]*$/m);

    expect(checkRecipe).toContain('pnpm run test:full');
    expect(checkRecipe).not.toContain('pnpm run test:minimal');
  });

  it('runs the full suite from pnpm ci', () => {
    expect(packageScripts.ci).toContain('pnpm run test:full');
    expect(packageScripts.ci).not.toContain('pnpm run test:minimal');
  });

  it('runs the full suite for code changes and a focused check for docs-only changes', () => {
    const testJob = topLevelBlock(gitlabPipeline, /^test:$/m);

    expect(testJob).toContain('node scripts/ci-test-scope.mjs');
    expect(testJob).toContain('node scripts/spec-gaps.mjs --check');
    expect(testJob).toContain('pnpm run test:full');
    expect(testJob).not.toContain('pnpm run test:minimal');
  });

  it('does not repeat P0 smoke coverage in the remaining Playwright suite', () => {
    expect(packageScripts['test:e2e:rest']).toContain('P0 Crash and IME Regressions');
  });

  it('uses bounded Playwright concurrency without multiplying CI jobs', () => {
    const markdownJob = topLevelBlock(gitlabPipeline, /^test:e2e:markdown-spec:$/m);
    const restJob = topLevelBlock(gitlabPipeline, /^test:e2e:rest:$/m);

    expect(markdownJob).toContain('pnpm run test:markdown-spec');
    expect(restJob).toContain('pnpm run test:e2e:rest');
    expect(packageScripts['test:markdown-spec']).not.toContain('--workers=');
    expect(packageScripts['test:e2e:rest']).toContain('--workers=2');
    expect(markdownJob).not.toContain('parallel: 2');
    expect(restJob).not.toContain('parallel: 2');
    expect(markdownJob).not.toContain('--shard=');
    expect(restJob).not.toContain('--shard=');
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

  it('keeps mobile-target Rust compile coverage on every crate change', () => {
    // The full native builds are scoped to shell/FFI changes, so these checks
    // are what proves an inner-crate change still compiles for mobile targets.
    const androidCheckJob = topLevelBlock(gitlabPipeline, /^test:rust:ffi-android:$/m);
    const macosRustJob = topLevelBlock(gitlabPipeline, /^test:rust:macos:$/m);
    const macosRustTask = topLevelBlock(cirrusTasks, /^test_rust_macos_task:$/m);
    const releaseGate = topLevelBlock(gitlabPipeline, /^release:gate:$/m);

    expect(androidCheckJob).toContain('- crates/**/*');
    expect(androidCheckJob).toContain('build -p futo-notes-ffi --profile release-ffi');
    // Serialized against the sync suite on the shared pinned runner — a
    // concurrent full-tree compile flakes its timing-sensitive scenarios —
    // and ordered after it, so the exclusion never delays the sync suite.
    expect(androidCheckJob).toContain('resource_group: cross-platform-sync');
    expect(androidCheckJob).toContain('job: test:cross-platform-sync');
    expect(macosRustJob).toContain('- crates/**/*');
    expect(macosRustTask).toContain('cargo check -p futo-notes-ffi --target aarch64-apple-ios');
    expect(releaseGate).toContain('- job: test:rust:ffi-android');
  });

  it('skips slow sync scenarios only on MR pipelines, never on main or tags', () => {
    const syncJob = topLevelBlock(gitlabPipeline, /^test:cross-platform-sync:$/m);

    expect(syncJob).toContain('node tests/cross-platform-sync.mjs $SYNC_SCENARIO_FLAGS');
    // Exactly the two auto-run MR rules (lockfile, sync-critical) set the
    // flag; the tag, default-branch, and manual rules run the full set.
    expect(syncJob.match(/SYNC_SCENARIO_FLAGS: --skip-slow/g)).toHaveLength(2);
    expect(syncJob).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
  });

  it('limits the pre-baked image to jobs that benefit from it', () => {
    const defaultBlock = topLevelBlock(gitlabPipeline, /^default:$/m);
    const testImageBlock = topLevelBlock(gitlabPipeline, /^\.ci-test-image:$/m);
    const rustWorkspaceJob = topLevelBlock(gitlabPipeline, /^test:rust:workspace:$/m);
    const syncJob = topLevelBlock(gitlabPipeline, /^test:cross-platform-sync:$/m);

    expect(defaultBlock).toMatch(/^\s+image: .*\/kitchensink@sha256:[a-f0-9]{64}$/m);
    expect(testImageBlock).toMatch(/^\s+name: .*\/ci\/test@sha256:[a-f0-9]{64}$/m);
    expect(testImageBlock).toContain('pull_policy: if-not-present');
    expect(rustWorkspaceJob).toContain('extends: .ci-test-image');
    expect(syncJob).toContain('extends: .ci-test-image');
  });
});
