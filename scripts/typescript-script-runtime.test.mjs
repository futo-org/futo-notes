import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPERATIONAL_MANIFESTS = ['.gitlab-ci.yml', 'justfile', 'package.json'];
const PLAIN_NODE_TYPESCRIPT = /\bnode\s+(?:"[^"\n]*\.ts"|'[^'\n]*\.ts'|\S+\.ts)\b/g;
const PLAIN_NODE_JAVASCRIPT =
  /\bnode\s+(?:"([^"\n]*\.(?:[cm]?js))"|'([^'\n]*\.(?:[cm]?js))'|([^\s"']+\.(?:[cm]?js)))\b/g;
const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function repositoryPath(commandPath) {
  return normalize(commandPath.replace(/^\$\{?CI_PROJECT_DIR\}?\//, ''));
}

function findTypeScriptImportChains(relativePath, chain = [], visited = new Set()) {
  if (visited.has(relativePath)) return [];
  visited.add(relativePath);

  const absolutePath = join(ROOT, relativePath);
  if (!existsSync(absolutePath)) return [];

  const nextChain = [...chain, relativePath];
  const contents = readFileSync(absolutePath, 'utf8');
  const findings = [];

  for (const match of contents.matchAll(LOCAL_IMPORT)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;

    const importedPath = normalize(join(dirname(relativePath), specifier));
    if (TYPESCRIPT_EXTENSIONS.has(extname(importedPath))) {
      findings.push([...nextChain, importedPath].join(' -> '));
      continue;
    }

    if (['.js', '.mjs', '.cjs'].includes(extname(importedPath))) {
      findings.push(...findTypeScriptImportChains(importedPath, nextChain, visited));
    }
  }

  return findings;
}

describe('TypeScript script runtimes', () => {
  it('does not invoke TypeScript entrypoints with plain Node', () => {
    const invalidInvocations = OPERATIONAL_MANIFESTS.flatMap((relativePath) => {
      const contents = readFileSync(join(ROOT, relativePath), 'utf8');
      return [...contents.matchAll(PLAIN_NODE_TYPESCRIPT)].map(
        (match) => `${relativePath}: ${match[0]}`,
      );
    });

    expect(invalidInvocations).toEqual([]);
  });

  it('does not reach TypeScript through plain Node JavaScript entrypoints', () => {
    const invalidImportChains = OPERATIONAL_MANIFESTS.flatMap((relativePath) => {
      const contents = readFileSync(join(ROOT, relativePath), 'utf8');
      return [...contents.matchAll(PLAIN_NODE_JAVASCRIPT)].flatMap((match) => {
        const entrypoint = repositoryPath(match[1] ?? match[2] ?? match[3]);
        return findTypeScriptImportChains(entrypoint).map(
          (chain) => `${relativePath}: node ${entrypoint}: ${chain}`,
        );
      });
    });

    expect(invalidImportChains).toEqual([]);
  });
});

// The house main-guard, `import.meta.url === pathToFileURL(process.argv[1]).href`,
// throws ERR_INVALID_ARG_TYPE ("The 'path' argument must be of type string.
// Received undefined") when the module is IMPORTED from a context with no
// script path — `node -e` / `node --input-type=module`. That is exactly how an
// agent pokes at an exported helper for an ad-hoc check, so the module crashed
// before running anything (pc_85196368c500, pc_b723be936925).
//
// scripts/lib/slot.mjs already guarded with `process.argv[1] &&`; nine other
// scripts did not. This keeps every script on the guarded form (M17).
describe('main-guard is safe to import from node -e', () => {
  const GUARDED = 'process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href';
  const UNGUARDED = 'import.meta.url === pathToFileURL(process.argv[1]).href';

  function scriptFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...scriptFiles(full));
      // Skip *.test.mjs: not entry points, and this file names both forms
      // as string literals to test for them.
      else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) out.push(full);
    }
    return out;
  }

  it('never uses the unguarded form', () => {
    const offenders = [];
    for (const file of scriptFiles(join(ROOT, 'scripts'))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes(UNGUARDED)) continue;
      // Strip the guarded occurrences; anything left is the bare form.
      if (text.split(GUARDED).join('').includes(UNGUARDED)) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
