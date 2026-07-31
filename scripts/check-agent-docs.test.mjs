import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectInstructionFiles,
  extractReferences,
  parseJustRecipes,
  parsePackageScripts,
  resolvePathCheckTarget,
  validateReferences,
} from './check-agent-docs.mjs';

describe('collectInstructionFiles', () => {
  it('does not scan instruction files from nested Git worktrees', () => {
    const root = mkdtempSync(join(tmpdir(), 'futo-agent-docs-'));

    try {
      writeFileSync(join(root, 'AGENTS.md'), '# Root instructions\n');

      const conventionalWorktree = join(root, '.worktrees', 'feature');
      mkdirSync(conventionalWorktree, { recursive: true });
      writeFileSync(join(conventionalWorktree, '.git'), 'gitdir: /tmp/feature.git\n');
      writeFileSync(join(conventionalWorktree, 'AGENTS.md'), '# Different checkout\n');

      const claudeWorktree = join(root, '.claude', 'worktrees', 'review');
      mkdirSync(claudeWorktree, { recursive: true });
      writeFileSync(join(claudeWorktree, '.git'), 'gitdir: /tmp/review.git\n');
      writeFileSync(join(claudeWorktree, 'AGENTS.md'), '# Different checkout\n');

      expect(collectInstructionFiles(root)).toEqual([join(root, 'AGENTS.md')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseJustRecipes', () => {
  it('parses plain recipes, parameterized recipes, dependency recipes, and aliases', () => {
    const justfile = [
      'alias b := build',
      '',
      '# Lint everything',
      'lint:',
      '  pnpm run lint',
      '',
      'tauri-dev *args:',
      '  node scripts/tauri-dev.mjs {{args}}',
      '',
      'sim-boot name="iPhone 17 Pro":',
      '  echo hi',
      '',
      'check: lint test-rust',
      '  pnpm run build',
    ].join('\n');

    const recipes = parseJustRecipes(justfile);
    expect(recipes).toEqual(new Set(['b', 'lint', 'tauri-dev', 'sim-boot', 'check']));
  });

  it('does not mistake an alias line for a recipe named "alias"', () => {
    const recipes = parseJustRecipes('alias td := tauri-dev\n');
    expect(recipes.has('alias')).toBe(false);
    expect(recipes.has('td')).toBe(true);
  });
});

describe('parsePackageScripts', () => {
  it('reads the scripts object keys', () => {
    const scripts = parsePackageScripts(
      JSON.stringify({ scripts: { build: 'vite build', test: 'vitest' } }),
    );
    expect(scripts).toEqual(new Set(['build', 'test']));
  });
});

describe('extractReferences', () => {
  it('extracts a `just <recipe>` reference from an inline backtick span with its line number', () => {
    const refs = extractReferences('Run `just tauri-dev` to start desktop dev.\n');
    expect(refs).toContainEqual({ line: 1, kind: 'just', value: 'tauri-dev' });
  });

  it('ignores "just" in plain prose outside backticks', () => {
    const refs = extractReferences('This is just a quick fix, not a full rewrite.\n');
    expect(refs.filter((r) => r.kind === 'just')).toEqual([]);
  });

  it('extracts references from inside a fenced code block without per-line backticks', () => {
    const text = ['```bash', 'just install', 'pnpm run tauri:dev', '```', ''].join('\n');
    const refs = extractReferences(text);
    expect(refs).toContainEqual({ line: 2, kind: 'just', value: 'install' });
    expect(refs).toContainEqual({ line: 3, kind: 'pnpm', value: 'tauri:dev' });
  });

  it('extracts a repo path with a known top-level prefix and no extension', () => {
    const refs = extractReferences('See `packages/editor/src/toolbar.ts` for the manifest.\n');
    expect(refs).toContainEqual({ line: 1, kind: 'path', value: 'packages/editor/src/toolbar.ts' });
  });

  it('skips URLs, placeholders, and brace/`$` patterns', () => {
    const text = [
      'See <https://gitlab.futo.org/futo-notes/futo-notes-server>.',
      'Read `docs/spec/<area>.md` for the area.',
      'Both `packages/editor/src/{filename,tags}.ts` copies move together.',
      'The `$FUTO_NOTES_E2EE_SERVER_REPO` var overrides the path.',
    ].join('\n');
    const refs = extractReferences(text);
    expect(refs.filter((r) => r.kind === 'path')).toEqual([]);
  });

  it('does not validate a bare filename with no slash and no known prefix', () => {
    const refs = extractReferences('Run `just` with no args to list recipes, per `justfile`.\n');
    expect(refs.filter((r) => r.kind === 'path')).toEqual([]);
  });

  it('honors the ignore-next-line escape hatch for Markdown and JS', () => {
    const md = [
      '<!-- check-agent-docs: ignore-next-line -->',
      '`just test-shared` was removed on purpose.',
      '',
    ].join('\n');
    expect(extractReferences(md).filter((r) => r.kind === 'just')).toEqual([]);

    const js = ['// check-agent-docs: ignore-next-line', "'just test-shared'", ''].join('\n');
    expect(extractReferences(js).filter((r) => r.kind === 'just')).toEqual([]);
  });

  it('honors the ignore-next-block escape hatch for a whole fenced block', () => {
    const text = [
      '<!-- check-agent-docs: ignore-next-block -->',
      '```sh',
      'cd apps/tauri && \\',
      '  cargo tauri dev --config src-tauri/tauri.dev.conf.json',
      '```',
      'But `docs/spec/editor.md` right after the block still gets checked.',
      '',
    ].join('\n');
    const refs = extractReferences(text);
    expect(refs.filter((r) => r.kind === 'path')).toEqual([
      { line: 6, kind: 'path', value: 'docs/spec/editor.md' },
    ]);
  });

  it('does not let ignore-next-block leak into an unmarked later block', () => {
    const text = [
      '<!-- check-agent-docs: ignore-next-block -->',
      '```sh',
      'src-tauri/tauri.dev.conf.json',
      '```',
      '```sh',
      'packages/shared/filename.ts',
      '```',
      '',
    ].join('\n');
    const refs = extractReferences(text);
    expect(refs.filter((r) => r.kind === 'path')).toEqual([
      { line: 6, kind: 'path', value: 'packages/shared/filename.ts' },
    ]);
  });
});

describe('resolvePathCheckTarget', () => {
  it('passes a plain path through unchanged', () => {
    expect(resolvePathCheckTarget('docs/spec/editor.md')).toEqual({
      target: 'docs/spec/editor.md',
      isGlob: false,
    });
  });

  it('reduces a glob to its static prefix directory', () => {
    expect(resolvePathCheckTarget('tests/conformance/*.json')).toEqual({
      target: 'tests/conformance',
      isGlob: true,
    });
    expect(resolvePathCheckTarget('src/lib/platform/**')).toEqual({
      target: 'src/lib/platform',
      isGlob: true,
    });
  });
});

describe('validateReferences', () => {
  const justRecipes = new Set(['tauri-dev', 'check']);
  const pnpmScripts = new Set(['build', 'test:unit']);

  it('flags an unknown just recipe and pnpm script by name', () => {
    const refs = [
      { line: 1, kind: 'just', value: 'test-shared' },
      { line: 2, kind: 'pnpm', value: 'tauri:dev' },
    ];
    const violations = validateReferences(refs, {
      justRecipes,
      pnpmScripts,
      pathExists: () => true,
    });
    expect(violations).toEqual([
      { line: 1, message: 'just test-shared — no such justfile recipe' },
      { line: 2, message: 'pnpm run tauri:dev — no such package.json script' },
    ]);
  });

  it('flags a missing path and a glob whose static prefix directory is missing', () => {
    const refs = [
      { line: 3, kind: 'path', value: 'packages/shared/filename.ts' },
      { line: 4, kind: 'path', value: 'packages/shared/*.ts' },
    ];
    const violations = validateReferences(refs, {
      justRecipes,
      pnpmScripts,
      pathExists: () => false,
    });
    expect(violations).toEqual([
      { line: 3, message: 'packages/shared/filename.ts — path does not exist' },
      {
        line: 4,
        message:
          "packages/shared/*.ts — glob's static prefix directory 'packages/shared' does not exist",
      },
    ]);
  });

  it('passes through when everything resolves', () => {
    const refs = [
      { line: 1, kind: 'just', value: 'check' },
      { line: 2, kind: 'pnpm', value: 'build' },
      { line: 3, kind: 'path', value: 'docs/spec/editor.md' },
    ];
    expect(validateReferences(refs, { justRecipes, pnpmScripts, pathExists: () => true })).toEqual(
      [],
    );
  });
});
