import { existsSync, readFileSync } from 'node:fs';
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
