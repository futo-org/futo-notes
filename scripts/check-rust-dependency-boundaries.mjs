import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BOUNDARIES = [
  {
    roots: ['futo-notes-core', 'futo-notes-model', 'futo-notes-sync'],
    forbidden: ['tantivy', 'ort', 'ort-sys'],
    reason: 'portable core crates must stay free of search/ML dependencies',
  },
  {
    roots: ['futo-notes-ffi'],
    forbidden: ['futo-notes-inference', 'ort', 'ort-sys'],
    reason: 'the native FFI facade must stay free of ORT/SPLADE',
  },
];

// A `kind` of null marks a normal dependency in `cargo metadata` output;
// "dev" and "build" edges never reach the shipped app, so following them
// would fail CI on test- or build-only dependencies (the retired dep-guard
// job used `cargo tree -e normal` for the same reason). Nodes without
// dep_kinds (very old cargo) conservatively count as normal.
function isShippedDependency(dep) {
  return !dep.dep_kinds || dep.dep_kinds.some((depKind) => depKind.kind === null);
}

export function dependencyBoundaryViolations(metadata, boundaries = BOUNDARIES) {
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const packageIdsByName = new Map(metadata.packages.map((pkg) => [pkg.name, pkg.id]));
  const dependenciesById = new Map(
    (metadata.resolve?.nodes ?? []).map((node) => [
      node.id,
      (node.deps ?? []).filter(isShippedDependency).map((dep) => dep.pkg),
    ]),
  );
  const violations = [];

  for (const boundary of boundaries) {
    for (const rootName of boundary.roots) {
      const rootId = packageIdsByName.get(rootName);
      if (!rootId) {
        violations.push({ root: rootName, dependency: '<missing>', reason: boundary.reason });
        continue;
      }

      const pending = [rootId];
      const visited = new Set();
      while (pending.length > 0) {
        const packageId = pending.pop();
        if (!packageId || visited.has(packageId)) continue;
        visited.add(packageId);

        const pkg = packagesById.get(packageId);
        if (packageId !== rootId && pkg && boundary.forbidden.includes(pkg.name)) {
          violations.push({ root: rootName, dependency: pkg.name, reason: boundary.reason });
        }
        pending.push(...(dependenciesById.get(packageId) ?? []));
      }
    }
  }

  return violations;
}

function main() {
  const result = spawnSync('cargo', ['metadata', '--locked', '--format-version=1'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const violations = dependencyBoundaryViolations(JSON.parse(result.stdout));
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `Dependency boundary failed: ${violation.root} reaches ${violation.dependency}; ${violation.reason}.`,
      );
    }
    process.exit(1);
  }

  console.log('Rust dependency boundaries are intact.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
