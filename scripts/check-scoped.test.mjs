import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  appGlobs,
  commandsFor,
  fsReadingTests,
  importClosure,
  planCheck,
  rustExternalInputs,
} from './check-scoped.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The workspace's shape, trimmed to what the rules below exercise.
const packages = [
  { name: 'futo-notes-merge', dir: 'crates/futo-notes-merge', deps: [] },
  { name: 'futo-notes-license', dir: 'crates/futo-notes-license', deps: [] },
  { name: 'futo-notes-core', dir: 'crates/futo-notes-core', deps: ['futo-notes-merge'] },
  { name: 'futo-notes-model', dir: 'crates/futo-notes-model', deps: ['futo-notes-core'] },
  {
    name: 'futo-notes-tauri',
    dir: 'apps/tauri/src-tauri',
    deps: ['futo-notes-core', 'futo-notes-license'],
  },
];
const rust = { packages, inputs: { 'futo-notes-tauri': ['languages/en.json'] } };

function plan(...paths) {
  const changed = paths.map((p) =>
    p.startsWith('-') ? { path: p.slice(1), deleted: true } : { path: p, deleted: false },
  );
  const differentialInputs = ['src/shared/note/wikilinks.ts'];
  const globs = [
    { dir: 'languages', module: 'src/shared/localization/bundledLanguageCatalogs.ts' },
  ];
  const { full, steps } = planCheck({ changed, rust, differentialInputs, globs });
  return {
    full,
    run: steps.filter((s) => s.run).map((s) => s.id),
    step: (id) => steps.find((s) => s.id === id),
  };
}

describe('planCheck', () => {
  it.each([
    [[], 'nothing changed'],
    [['experiments/probe.ts'], 'no rule claims'],
    [['package.json'], 'no rule claims'],
    [['just/test.justfile'], 'configures the checks'],
    [['crates/stray.rs'], 'in no Cargo package'],
  ])(
    'runs everything for %j — a scoped green must not stand in for skipped checks',
    (paths, why) => {
      const { full, run } = plan(...paths);
      expect(full).toContain(why);
      expect(run).toHaveLength(14);
    },
  );

  it('a docs-only change runs only the gates and the fs-reading tests', () => {
    const { full, run, step } = plan('docs/spec/search.md');
    expect(full).toBeNull();
    expect(run).toEqual(['arch-gate', 'vitest']);
    // No changed module must still mean "the fs-reading tests", not the whole suite.
    const commands = commandsFor(step('vitest'), ['scripts/reads-docs.test.mjs']);
    expect(commands.at(-1)[1]).toEqual(
      expect.arrayContaining(['related', 'scripts/reads-docs.test.mjs']),
    );
    expect(commands.flat(2)).not.toContain('test:full');
  });

  it('a Rust change runs its crate and every crate depending on it, nothing web', () => {
    const { run, step } = plan('crates/futo-notes-license/src/lib.rs');
    expect(run).toEqual([
      'arch-gate',
      'sync-contract',
      'test-license',
      'rust-fmt',
      'clippy',
      'vitest',
    ]);
    expect(step('clippy').why).toBe('affected: futo-notes-license futo-notes-tauri');
  });

  it('a change deep in the graph reaches every test-rust crate it feeds', () => {
    const { step } = plan('crates/futo-notes-merge/src/lib.rs');
    expect(step('test-rust').args).toEqual(['futo-notes-core', 'futo-notes-merge']);
    expect(step('rust-conformance').run).toBe(true);
    expect(step('differential').run).toBe(true);
  });

  it('a non-Rust file a crate reads makes that crate affected', () => {
    const { run } = plan('languages/en.json');
    expect(run).toContain('sync-contract');
    expect(run).toContain('build');
  });

  it('a deleted JS module runs the whole vitest suite', () => {
    const { step } = plan('-scripts/lib/old-helper.mjs');
    expect(step('vitest')).toMatchObject({ run: true, args: [], why: 'a JS module was deleted' });
  });

  it('a web change runs the whole-program web steps and formats only the changed file', () => {
    const { run, step } = plan('src/features/sync/qrCode.ts');
    expect(run).toEqual([
      'arch-gate',
      'eslint',
      'svelte-check',
      'prettier',
      'vitest',
      'tsc',
      'build',
    ]);
    expect(step('prettier').args).toEqual(['src/features/sync/qrCode.ts']);
  });

  it('a TS file the differential imports runs the differential', () => {
    expect(plan('src/shared/note/wikilinks.ts').step('differential')).toMatchObject({
      run: true,
      why: 'it imports or reads src/shared/note/wikilinks.ts',
    });
  });
});

describe('vitest selection', () => {
  it('a new file in a globbed directory reaches the tests of the module that globs it', () => {
    expect(plan('languages/xx.json').step('vitest').args).toContain(
      'src/shared/localization/bundledLanguageCatalogs.ts',
    );
    expect(appGlobs(ROOT)).toContainEqual({
      dir: 'languages',
      module: 'src/shared/localization/bundledLanguageCatalogs.ts',
    });
  });

  // release-channel.test.mjs reads .gitlab-ci.yml only through readGitlabCiSource, so a
  // scan of the test's own source missed it and a ci/ change skipped it (Codex review).
  it('counts a test that reads files through a helper it imports', () => {
    const tests = fsReadingTests(ROOT);
    expect(tests).toContain('scripts/release-channel.test.mjs');
    // Browser app code calling the Tauri readFile API is not a file read.
    expect(tests).not.toContain('src/lib/platform/tauri/images.test.ts');
  });
});

describe('importClosure', () => {
  // A miss here skips the TS↔Rust differential for a rule it compares.
  it('reaches every TS rule mirror the differential compares', () => {
    const closure = importClosure(ROOT, 'tests/conformance/title-rules-differential.mjs');
    expect(closure).toEqual(
      expect.arrayContaining([
        'packages/editor/src/filename.ts',
        'packages/editor/src/tags.ts',
        'src/shared/note/wikilinks.ts',
      ]),
    );
  });
});

describe('rustExternalInputs', () => {
  // Each of these is a real include_str!/CARGO_MANIFEST_DIR read; if the scan stops
  // finding one, a change to that file would skip the crate that reads it.
  it('finds the files crates embed or read from outside their own directory', () => {
    const inputs = rustExternalInputs(ROOT, [
      { name: 'core', dir: 'crates/futo-notes-core' },
      { name: 'model', dir: 'crates/futo-notes-model' },
      { name: 'store', dir: 'crates/futo-notes-store' },
      { name: 'tauri', dir: 'apps/tauri/src-tauri' },
      { name: 'cli', dir: 'apps/cli' },
    ]);
    expect(inputs.core).toContain('tests/conformance/path-safety.json');
    expect(inputs.model).toContain('tests/conformance/tags.json');
    expect(inputs.store).toContain('tests/fixtures/editor-native-input');
    expect(inputs.tauri).toEqual(
      expect.arrayContaining([
        'languages/en.json',
        'src/features/sync/syncContract.generated.ts',
        'src/shared/lifecycle/flushBeforeExit.ts',
      ]),
    );
    expect(inputs.cli).toContain('languages/en.json');
  });
});
