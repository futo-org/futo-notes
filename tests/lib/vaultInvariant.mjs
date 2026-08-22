const DATE_CONFLICT_TOKEN = String.raw`\d{4}-\d{2}-\d{2}(?: \d+)?`;
const OBJECT_CONFLICT_TOKEN = String.raw`(?:[a-fA-F0-9]{8}|(?=[a-zA-Z0-9]{8}\b)(?=[a-zA-Z0-9]*\d)[a-zA-Z0-9]{8}|object(?:-[a-zA-Z0-9]{1,8})?)`;
const CONFLICT_COPY_NAME = new RegExp(
  String.raw` \(conflict (?:${DATE_CONFLICT_TOKEN}|${OBJECT_CONFLICT_TOKEN})\)(?:\.[^/]+)?$`,
);

function normalizedPaths(paths) {
  return [...new Set(paths.map((path) => String(path).replaceAll('\\', '/')))].sort();
}

/**
 * Files created by a device story that the story did not explicitly permit,
 * plus every generated conflict-copy-shaped file left in the resulting vault.
 *
 * Snapshots are platform-blind relative paths. `expectedCreations` is an
 * allowlist, not an assertion that each path must be new: a migration may copy
 * a file into a destination where an identical entry already existed.
 */
export function vaultInvariant(before, after, expectedCreations = []) {
  const beforePaths = new Set(normalizedPaths(before));
  const afterPaths = normalizedPaths(after);
  const expected = new Set(normalizedPaths(expectedCreations));
  const violations = [];

  for (const path of afterPaths) {
    if (CONFLICT_COPY_NAME.test(path)) {
      violations.push({ kind: 'conflict-copy', path });
    }
    if (!beforePaths.has(path) && !expected.has(path)) {
      violations.push({ kind: 'unexpected-creation', path });
    }
  }

  return violations;
}

export function describeVaultViolations(violations) {
  return violations
    .map(({ kind, path }) =>
      kind === 'conflict-copy'
        ? `generated conflict copy: ${path}`
        : `unexpected file creation: ${path}`,
    )
    .join('; ');
}
