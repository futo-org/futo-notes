import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP_CODE = /^(src|packages\/editor\/src)\//;

const VITEST_TEST = /\.test\.(ts|mjs)$/;
/** A test that reads, spawns or globs files: imports alone cannot say what it depends on. */
const READS_OUTSIDE_IMPORTS =
  /readFileSync|readFile\(|readdirSync|execFileSync|spawnSync|execSync|import\.meta\.glob|\?raw/;

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
export function strictClosure(root, entry) {
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

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
}

/** @returns {{ base: string, changed: { path: string, deleted: boolean }[] } | { error: string }} */
export function changedFiles(root, baseRef) {
  let base;
  try {
    base = git(root, ['merge-base', 'HEAD', baseRef]).trim();
  } catch {
    return { error: `cannot find merge-base with ${baseRef}` };
  }
  const entries = new Map();
  const diff = git(root, ['diff', '--name-status', '-z', '--no-renames', base]).split('\0');
  for (let i = 0; i + 1 < diff.length; i += 2) {
    entries.set(diff[i + 1], { path: diff[i + 1], deleted: diff[i] === 'D' });
  }
  for (const p of git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0')) {
    if (p) entries.set(p, { path: p, deleted: false });
  }
  return { base, changed: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

export function cargoPackages(root) {
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--offline'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    }),
  );
  return meta.packages.map((p) => ({
    name: p.name,
    dir: path.relative(root, path.dirname(p.manifest_path)).split(path.sep).join('/'),
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
  return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter((f) => VITEST_TEST.test(f) && fs.existsSync(path.join(root, f)))
    .filter((f) => importClosure(root, f, cache).some(readsOutside));
}
