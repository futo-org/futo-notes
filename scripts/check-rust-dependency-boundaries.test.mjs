import { describe, expect, it } from 'vitest';

import { dependencyBoundaryViolations } from './check-rust-dependency-boundaries.mjs';

// Edges are [from, to, kind?] where kind defaults to a normal dependency
// (cargo metadata encodes normal as `kind: null`); pass 'dev' or 'build' to
// model test-/build-only edges.
function metadata(edges) {
  const names = new Set(edges.flatMap(([from, to]) => [from, to]));
  return {
    packages: [...names].map((name) => ({ id: `${name}@1`, name })),
    resolve: {
      nodes: [...names].map((name) => ({
        id: `${name}@1`,
        deps: edges
          .filter(([from]) => from === name)
          .map(([, to, kind]) => ({ pkg: `${to}@1`, dep_kinds: [{ kind: kind ?? null }] })),
      })),
    },
  };
}

describe('Rust dependency boundaries', () => {
  it('accepts the current portable layering', () => {
    const graph = metadata([
      ['futo-notes-core', 'serde'],
      ['futo-notes-model', 'serde'],
      ['futo-notes-sync', 'futo-notes-core'],
      ['futo-notes-ffi', 'futo-notes-search'],
      ['futo-notes-search', 'tantivy'],
    ]);

    expect(dependencyBoundaryViolations(graph)).toEqual([]);
  });

  it('detects forbidden transitive dependencies from portable crates', () => {
    const graph = metadata([
      ['futo-notes-core', 'helper'],
      ['helper', 'ort'],
      ['futo-notes-model', 'serde'],
      ['futo-notes-sync', 'futo-notes-core'],
      ['futo-notes-ffi', 'futo-notes-search'],
    ]);

    expect(dependencyBoundaryViolations(graph)).toContainEqual({
      root: 'futo-notes-core',
      dependency: 'ort',
      reason: 'portable core crates must stay free of search/ML dependencies',
    });
  });

  it('ignores dev- and build-only dependencies, which never ship', () => {
    const graph = metadata([
      ['futo-notes-core', 'tantivy', 'dev'],
      ['futo-notes-model', 'ort', 'build'],
      ['futo-notes-model', 'helper'],
      ['helper', 'ort', 'dev'],
      ['futo-notes-sync', 'futo-notes-core'],
      ['futo-notes-ffi', 'serde'],
    ]);

    expect(dependencyBoundaryViolations(graph)).toEqual([]);
  });

  it('detects inference dependencies behind the FFI facade', () => {
    const graph = metadata([
      ['futo-notes-core', 'serde'],
      ['futo-notes-model', 'serde'],
      ['futo-notes-sync', 'futo-notes-core'],
      ['futo-notes-ffi', 'futo-notes-inference'],
    ]);

    expect(dependencyBoundaryViolations(graph)).toContainEqual({
      root: 'futo-notes-ffi',
      dependency: 'futo-notes-inference',
      reason: 'the native FFI facade must stay free of ORT/SPLADE',
    });
  });
});
