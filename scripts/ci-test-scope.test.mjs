import { describe, expect, it } from 'vitest';

import { classifyChangedFiles } from './ci-test-scope.mjs';

describe('CI test scope', () => {
  it('routes documentation-only changes to the fast path', () => {
    expect(classifyChangedFiles(['README.md', 'docs/spec/editor.md'])).toBe('docs');
  });

  it('keeps markdown behavior fixtures on the full path', () => {
    expect(classifyChangedFiles(['docs/spec/editor.md', 'markdown-spec/cases/lists.yaml'])).toBe(
      'full',
    );
  });

  it('keeps source changes on the full path', () => {
    expect(classifyChangedFiles(['docs/plan/editor.md', 'src/App.svelte'])).toBe('full');
  });

  it('fails safe when the changed-file list cannot be determined', () => {
    expect(classifyChangedFiles([])).toBe('full');
  });
});
