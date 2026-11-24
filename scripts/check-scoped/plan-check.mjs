/** Changes here can alter what any step does, so they run everything. */
const FULL_PATHS = [
  'packages/editor/package.json',
  'packages/editor/tsconfig.json',
  'packages/editor/vitest.config.ts',
  'scripts/check-scoped.mjs',
  'scripts/check-scoped/plan-check.mjs',
  'scripts/check-scoped/repo-inputs.mjs',
  'scripts/check-scoped/step-commands.mjs',
  'scripts/format.mjs',
  'scripts/editor-deps.mjs',
  'scripts/lib/test-worker-budget.mjs',
  'scripts/lib/slot.mjs',
];

/** Paths whose only consumers are the always-run gates and the fs-reading tests. */
const DATA_PREFIXES = ['docs/', 'release-notes/', '.claude/', 'ci/', 'apps/ios/', 'apps/android/'];
const DATA_FILES = ['.papercuts.jsonl', '.gitlab-ci.yml', '.cirrus.yml', '.cirrus.star'];
const WEB_PREFIXES = ['src/', 'packages/editor/', 'languages/', 'assets/'];
const WEB_FILES = ['index.html'];
const JS_PREFIXES = ['scripts/', 'tests/'];
const LINT_PREFIXES = ['src/', 'packages/editor/src/', 'tests/'];
const MODULE_EXT = /\.(ts|mts|js|mjs|cjs|svelte|json)$/;
const LINT_EXT = /\.(ts|mts|js|mjs|cjs|svelte)$/;
const PRETTIER_EXT = /\.(ts|svelte|js|mjs|cjs|css)$/;

/** The crates `just test-rust` runs `cargo test -p` on. */
const TEST_RUST_PACKAGES = [
  'futo-notes-editor',
  'futo-notes-store',
  'futo-notes-core',
  'futo-notes-merge',
];

/**
 * Pure plan. `changed` is [{ path, deleted }]; `rust` is { packages: [{ name, dir,
 * deps }], inputs: { [pkgName]: [repoPath] } }; `differentialInputs` is the TS↔Rust
 * differential's import closure (repo paths); `globs` is [{ dir, module }] for each
 * `import.meta.glob` in app code, so a file landing in `dir` reaches `module`'s tests.
 * @returns {{ full: string|null, steps: { id: string, run: boolean, why: string, args?: string[] }[] }}
 */
export function planCheck({ changed, rust, differentialInputs = [], globs = [], full = null }) {
  if (!full && changed.length === 0) full = 'nothing changed against the base';
  const byPath = new Map(rust.packages.map((p) => [p.dir, p]));
  const pkgDirs = [...byPath.keys()].sort((a, b) => b.length - a.length);

  const touched = new Set();
  let web = false;
  let lint = false;
  let fullVitest = false;
  let anyRs = false;
  const moduleFiles = [];
  const prettierFiles = [];

  for (const { path: p, deleted } of full ? [] : changed) {
    const reason = claim(p);
    if (reason === null) {
      full = `no rule claims ${p}`;
      break;
    }
    if (reason === 'full') {
      full = `${p} configures the checks themselves`;
      break;
    }
    for (const [name, inputs] of Object.entries(rust.inputs)) {
      if (inputs.some((i) => p === i || p.startsWith(`${i}/`))) touched.add(name);
    }
    if (reason === 'rust') {
      const dir = pkgDirs.find((d) => p.startsWith(`${d}/`));
      if (!dir) {
        full = `${p} is in no Cargo package`;
        break;
      }
      touched.add(byPath.get(dir).name);
      if (p.endsWith('.rs')) anyRs = true;
    }
    if (reason === 'web') web = true;
    if (LINT_EXT.test(p) && LINT_PREFIXES.some((x) => p.startsWith(x))) lint = true;
    if (MODULE_EXT.test(p)) {
      if (deleted) fullVitest = true;
      else moduleFiles.push(p);
    }
    if (!deleted && PRETTIER_EXT.test(p)) prettierFiles.push(p);
    for (const g of globs) if (p.startsWith(`${g.dir}/`)) moduleFiles.push(g.module);
  }

  const affected = full ? new Set(rust.packages.map((p) => p.name)) : dependents(rust, touched);
  const has = (name) => affected.has(name);
  const differentialInput = changed.find(
    (c) => differentialInputs.includes(c.path) || c.path.startsWith('tests/conformance/'),
  );
  const testRust = full
    ? TEST_RUST_PACKAGES
    : TEST_RUST_PACKAGES.filter((name) => affected.has(name));
  const rustWhy = affected.size ? `affected: ${[...affected].sort().join(' ')}` : 'no Rust change';
  const all = (run, why) => ({ run: Boolean(full) || run, why: full ? 'full run' : why });

  const steps = [
    { id: 'arch-gate', ...all(true, 'always (whole-repo gates)') },
    { id: 'sync-contract', ...all(has('futo-notes-tauri'), rustWhy) },
    { id: 'test-rust', ...all(testRust.length > 0, rustWhy), args: testRust },
    { id: 'rust-conformance', ...all(has('futo-notes-model'), rustWhy) },
    { id: 'test-license', ...all(has('futo-notes-license'), rustWhy) },
    {
      id: 'differential',
      ...all(
        has('futo-notes-model') || Boolean(differentialInput),
        differentialInput ? `it imports or reads ${differentialInput.path}` : rustWhy,
      ),
    },
    { id: 'rust-fmt', ...all(anyRs, anyRs ? '.rs changed' : 'no .rs change') },
    { id: 'clippy', ...all(affected.size > 0, rustWhy) },
    { id: 'eslint', ...all(lint, lint ? 'lintable source changed' : 'no lintable change') },
    { id: 'svelte-check', ...all(web, web ? 'web source changed' : 'no web change') },
    {
      id: 'prettier',
      ...all(prettierFiles.length > 0, `${prettierFiles.length} changed file(s)`),
      args: full ? [] : prettierFiles,
    },
    vitestStep({ full, fullVitest, moduleFiles }),
    { id: 'tsc', ...all(web, web ? 'web source changed' : 'no web change') },
    { id: 'build', ...all(web, web ? 'web source changed' : 'no web change') },
  ];
  return { full, steps };
}

function vitestStep({ full, fullVitest, moduleFiles }) {
  if (full) return { id: 'vitest', run: true, why: 'full run', whole: true, args: [] };
  if (fullVitest)
    return { id: 'vitest', run: true, why: 'a JS module was deleted', whole: true, args: [] };
  return {
    id: 'vitest',
    run: true,
    why: `tests related to ${moduleFiles.length} changed module(s) + fs-reading tests`,
    whole: false,
    args: moduleFiles,
  };
}

/** 'full' | 'rust' | 'web' | 'js' | 'data' | null (unclaimed). */
export function claim(p) {
  if (FULL_PATHS.includes(p) || p === 'justfile' || p.startsWith('just/')) return 'full';
  if (p.endsWith('.md')) return 'data';
  if (p.startsWith('crates/') || p.startsWith('apps/tauri/src-tauri/') || p.startsWith('apps/cli/'))
    return 'rust';
  if (WEB_FILES.includes(p) || WEB_PREFIXES.some((x) => p.startsWith(x))) return 'web';
  if (JS_PREFIXES.some((x) => p.startsWith(x))) return 'js';
  if (DATA_FILES.includes(p) || DATA_PREFIXES.some((x) => p.startsWith(x))) return 'data';
  return null;
}

/** `seeds` plus every workspace package that depends on one of them, transitively. */
export function dependents(rust, seeds) {
  const out = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of rust.packages) {
      if (!out.has(p.name) && p.deps.some((d) => out.has(d))) {
        out.add(p.name);
        grew = true;
      }
    }
  }
  return out;
}
