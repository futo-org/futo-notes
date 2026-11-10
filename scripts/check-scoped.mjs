#!/usr/bin/env node
// `just check`, scoped to what this branch changed; `just check-full` runs everything.
//
//   node scripts/check-scoped.mjs            scoped run (prints the plan first)
//   node scripts/check-scoped.mjs --plan     print the plan, run nothing
//   node scripts/check-scoped.mjs --full     every step, whatever changed
//   FUTO_CHECK_BASE=<ref>                    diff base (default origin/main)
//
// The changed set is the diff from merge-base(HEAD, base) plus staged, unstaged
// and untracked files. The rules are deny-by-default: an empty diff, a path no
// rule claims, or a root/tool config change runs every step (a scoped green
// must never stand in for a check that did not run, M11).
//
// What each step runs on:
//   Rust   - crates containing a change, crates whose .rs embeds or reads a
//            changed file outside the crate (include_str!, CARGO_MANIFEST_DIR
//            paths), and every crate that depends on those. test-rust's crate
//            list is intersected with that set; clippy and fmt stay
//            workspace-wide (cargo already rebuilds only what changed).
//   Web    - eslint, svelte-check, tsc and the vite build run whole-program
//            whenever their sources changed: they are a few seconds each, and a
//            whole run keeps type-aware lint rules seeing every caller.
//   Vitest - tests reached through imports from a changed file (`vitest
//            related`), plus every test that reads files outside its import
//            graph (fs reads, child processes, globs), which imports cannot
//            reveal. A deleted or renamed JS module runs the whole suite.
//   Format - prettier on the changed files only (it is file-local).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Changes here can alter what any step does, so they run everything. */
const FULL_PATHS = [
  'packages/editor/package.json',
  'packages/editor/tsconfig.json',
  'packages/editor/vitest.config.ts',
  'scripts/check-scoped.mjs',
  'scripts/format.mjs',
  'scripts/editor-deps.mjs',
  'scripts/lib/test-worker-budget.mjs',
  'scripts/lib/slot.mjs',
];

/** Paths whose only consumers are the always-run gates and the fs-reading tests. */
const DATA_PREFIXES = ['docs/', 'release-notes/', '.claude/', 'ci/', 'apps/ios/', 'apps/android/'];
const DATA_FILES = ['.papercuts.jsonl', '.gitlab-ci.yml', '.cirrus.yml', '.cirrus.star'];
const WEB_PREFIXES = ['src/', 'packages/editor/', 'languages/', 'assets/'];
const WEB_FILES = ['index.html', 'editor.html'];
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

const DIFFERENTIAL = 'tests/conformance/title-rules-differential.mjs';

const APP_CODE = /^(src|packages\/editor\/src)\//;

const VITEST_TEST = /\.test\.(ts|mjs)$/;
/** A test that reads, spawns or globs files: imports alone cannot say what it depends on. */
const READS_OUTSIDE_IMPORTS =
  /readFileSync|readFile\(|readdirSync|execFileSync|spawnSync|execSync|import\.meta\.glob|\?raw/;

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

/**
 * Repo paths outside a crate that its Rust source embeds or reads: string
 * literals with a `../` segment, resolved against the file (include_str!) and
 * the manifest dir (CARGO_MANIFEST_DIR concat/format/join). Format holes like
 * `{name}.json` cut the path back to its directory.
 */
export function rustExternalInputs(root, packages) {
  const inputs = {};
  for (const pkg of packages) {
    const found = new Set();
    for (const file of walk(path.join(root, pkg.dir), (f) => f.endsWith('.rs'))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const [, literal] of source.matchAll(/"((?:\{\})?\/?(?:\.\.\/)+[^"\n]*)"/g)) {
        let rel = literal.replace(/^\{\}/, '');
        const hole = rel.indexOf('{');
        if (hole >= 0) rel = rel.slice(0, rel.lastIndexOf('/', hole));
        const anchors = rel.startsWith('/')
          ? [path.join(root, pkg.dir)]
          : [path.dirname(file), path.join(root, pkg.dir)];
        for (const anchor of anchors) {
          const abs = path.resolve(anchor, rel.replace(/^\//, ''));
          const repoRel = path.relative(root, abs).split(path.sep).join('/');
          if (repoRel.startsWith('..') || !fs.existsSync(abs)) continue;
          if (repoRel === pkg.dir || repoRel.startsWith(`${pkg.dir}/`)) continue;
          found.add(repoRel);
        }
      }
    }
    if (found.size) inputs[pkg.name] = [...found].sort();
  }
  return inputs;
}

/** vitest.config.ts `resolve.alias`, as repo-relative prefixes. */
const ALIASES = [
  ['$lib/', 'src/lib/'],
  ['$app/', 'src/app/'],
  ['$features/', 'src/features/'],
  ['$shared/', 'src/shared/'],
  ['@/', ''],
  ['@futo-notes/editor', 'packages/editor/src'],
];
const SOURCE_EXT = /\.(ts|mts|js|mjs|cjs|svelte)$/;
/** Closure entry for an import that resolved to no file: callers must assume the worst. */
export const UNRESOLVED = '<unresolved import>';
const RESOLVE_SUFFIXES = ['', '.ts', '.mjs', '.js', '.svelte', '/index.ts', '/index.mjs'];

/** Absolute paths of the repo files `abs` imports (relative or aliased; packages skipped). */
function importsOf(root, abs, cache) {
  if (cache.has(abs)) return cache.get(abs);
  const out = [];
  cache.set(abs, out);
  const source = fs.readFileSync(abs, 'utf8');
  for (const [, raw] of source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"\n]+)['"]/g)) {
    const spec = raw.replace(/\?.*$/, '');
    let base = null;
    if (spec.startsWith('./') || spec.startsWith('../'))
      base = path.resolve(path.dirname(abs), spec);
    else {
      const alias = ALIASES.find(([from]) => spec === from || spec.startsWith(from));
      if (alias) base = path.join(root, alias[1] + spec.slice(alias[0].length));
    }
    if (!base) continue;
    const stem = base.replace(/\.(m?js)$/, '');
    const hit = [...RESOLVE_SUFFIXES.map((x) => base + x), `${stem}.ts`, `${stem}.mts`].find(
      (f) => fs.existsSync(f) && fs.statSync(f).isFile(),
    );
    out.push(hit ?? UNRESOLVED);
  }
  return out;
}

/** Repo paths `entry` loads through relative or aliased imports, itself included. */
export function importClosure(root, entry, cache = new Map()) {
  const seen = new Set();
  const visit = (abs) => {
    const rel = abs === UNRESOLVED ? abs : path.relative(root, abs).split(path.sep).join('/');
    if (seen.has(rel)) return;
    seen.add(rel);
    if (abs !== UNRESOLVED && SOURCE_EXT.test(abs))
      for (const next of importsOf(root, abs, cache)) visit(next);
  };
  visit(path.join(root, entry));
  return [...seen].sort();
}

/** Every `import.meta.glob('<relative pattern>')` in app code, as { dir, module }. */
export function appGlobs(root) {
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  const out = [];
  for (const top of ['src', 'packages/editor/src']) {
    for (const abs of walk(path.join(root, top), (f) => SOURCE_EXT.test(f))) {
      const source = fs.readFileSync(abs, 'utf8');
      const literal = [...source.matchAll(/import\.meta\.glob\(\s*['"]([^'"]+)['"]/g)];
      // Fail closed: an array, alias or variable pattern would otherwise reach no tests.
      if (literal.length !== source.split('import.meta.glob(').length - 1)
        throw new Error(`${rel(abs)}: import.meta.glob needs one relative string pattern`);
      for (const [, pattern] of literal) {
        const wild = pattern.search(/[*{[?]/);
        const fixed = wild < 0 ? pattern : pattern.slice(0, wild);
        const dir = path.resolve(
          path.dirname(abs),
          fixed.slice(0, fixed.lastIndexOf('/') + 1) || '.',
        );
        out.push({ dir: rel(dir), module: rel(abs) });
      }
    }
  }
  return out;
}

/** The differential's inputs must all resolve, or a skipped input could hide a rule change. */
function strictClosure(root, entry) {
  const closure = importClosure(root, entry);
  if (closure.includes(UNRESOLVED)) throw new Error(`${entry}: an import resolves to no file`);
  return closure;
}

function* walk(dir, keep) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, keep);
    else if (keep(full)) yield full;
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
}

/** @returns {{ base: string, changed: { path: string, deleted: boolean }[] } | { error: string }} */
function changedFiles(baseRef) {
  let base;
  try {
    base = git(['merge-base', 'HEAD', baseRef]).trim();
  } catch {
    return { error: `cannot find merge-base with ${baseRef}` };
  }
  const entries = new Map();
  const diff = git(['diff', '--name-status', '-z', '--no-renames', base]).split('\0');
  for (let i = 0; i + 1 < diff.length; i += 2) {
    entries.set(diff[i + 1], { path: diff[i + 1], deleted: diff[i] === 'D' });
  }
  for (const p of git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0')) {
    if (p) entries.set(p, { path: p, deleted: false });
  }
  return { base, changed: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

function cargoPackages() {
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--offline'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    }),
  );
  return meta.packages.map((p) => ({
    name: p.name,
    dir: path.relative(ROOT, path.dirname(p.manifest_path)).split(path.sep).join('/'),
    deps: p.dependencies.filter((d) => d.path).map((d) => d.name),
  }));
}

/** Vitest tests whose dependencies imports cannot reveal: the test, or a module it
 *  imports, reads, spawns or globs files (a helper like readGitlabCiSource counts). */
export function fsReadingTests(root) {
  const cache = new Map();
  const reads = new Map();
  const readsOutside = (rel) => {
    if (rel === UNRESOLVED) return true;
    if (!reads.has(rel)) {
      const abs = path.join(root, rel);
      // App code runs in a browser: its only reads outside imports are globs, which
      // planCheck routes through `globs`. Tests, node code and __test__ helpers count.
      const appModule = APP_CODE.test(rel) && !VITEST_TEST.test(rel) && !rel.includes('/__test__/');
      reads.set(
        rel,
        SOURCE_EXT.test(rel) &&
          !appModule &&
          READS_OUTSIDE_IMPORTS.test(fs.readFileSync(abs, 'utf8')),
      );
    }
    return reads.get(rel);
  };
  return git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter((f) => VITEST_TEST.test(f) && fs.existsSync(path.join(root, f)))
    .filter((f) => importClosure(root, f, cache).some(readsOutside));
}

export function commandsFor(step, fsTests) {
  const pnpm = (...a) => ['pnpm', ['run', ...a]];
  switch (step.id) {
    case 'arch-gate':
      return [pnpm('check:arch-gate:portable')];
    case 'sync-contract':
      return [pnpm('check:sync-contract')];
    case 'test-rust':
      return [['cargo', ['test', ...step.args.flatMap((p) => ['-p', p])]]];
    case 'rust-conformance':
      return [['cargo', ['test', '-p', 'futo-notes-model', '--test', 'conformance']]];
    case 'test-license':
      return [['cargo', ['test', '-p', 'futo-notes-license']]];
    case 'differential':
      return [['node', ['--experimental-strip-types', DIFFERENTIAL]]];
    case 'rust-fmt':
      return [['cargo', ['fmt', '--all', '--check']]];
    case 'clippy':
      return [['cargo', ['clippy', '--workspace']]];
    case 'eslint':
      return [pnpm('lint')];
    case 'svelte-check':
      return [pnpm('check:svelte')];
    case 'prettier':
      return [['node', ['scripts/format.mjs', ...step.args]]];
    case 'vitest':
      if (step.whole) return [pnpm('test:full')];
      return [
        ['node', ['scripts/editor-deps.mjs']],
        [
          'node_modules/.bin/vitest',
          ['related', '--run', '--passWithNoTests', ...new Set([...step.args, ...fsTests])],
        ],
      ];
    case 'tsc':
      return [['pnpm', ['exec', 'tsc', '--noEmit']]];
    case 'build':
      return [pnpm('build')];
    default:
      throw new Error(`no command for step ${step.id}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const planOnly = argv.includes('--plan');
  const baseRef = process.env.FUTO_CHECK_BASE || 'origin/main';
  const t0 = Date.now();

  const diff = changedFiles(baseRef);
  const packages = cargoPackages();
  const rust = { packages, inputs: rustExternalInputs(ROOT, packages) };
  const forced = argv.includes('--full') ? 'requested with --full' : null;
  const plan = planCheck({
    changed: diff.changed ?? [],
    rust,
    differentialInputs: strictClosure(ROOT, DIFFERENTIAL),
    globs: appGlobs(ROOT),
    full: forced ?? diff.error ?? null,
  });
  const fsTests = fsReadingTests(ROOT);

  const head = diff.base
    ? `${diff.changed.length} changed file(s) vs ${baseRef} (merge-base ${diff.base.slice(0, 9)})`
    : diff.error;
  console.log(`\n==> check: ${head}`);
  console.log(
    plan.full ? `    FULL run: ${plan.full}` : '    scoped run (`just check-full` runs everything)',
  );
  for (const s of plan.steps) {
    console.log(`    ${s.run ? 'RUN ' : 'skip'}  ${s.id.padEnd(17)} ${s.why}`);
  }
  console.log(`    planned in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  if (planOnly) return;

  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const timings = [];
  for (const step of plan.steps.filter((s) => s.run)) {
    const started = Date.now();
    console.log(`==> ${step.id}`);
    for (const [cmd, args] of commandsFor(step, fsTests)) {
      const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
      if (result.status !== 0) {
        console.error(`\ncheck FAILED at ${step.id}: ${cmd} ${args.slice(0, 6).join(' ')}`);
        process.exit(result.status || 1);
      }
    }
    timings.push(`${step.id} ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  const mode = plan.full ? 'full' : 'scoped';
  console.log(
    `\ncheck green (${mode}, ${((Date.now() - t0) / 1000).toFixed(0)}s): ${timings.join(' · ')}`,
  );
}

if (import.meta.main) main();
