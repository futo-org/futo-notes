import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { justfilePaths, readJustCommands, readJustfileSource } from './justfile.mjs';
import { classifyRecipe } from '../remote-test.mjs';

function withJustfile(source, action) {
  const directory = mkdtempSync(join(tmpdir(), 'futo-just-'));
  const root = join(directory, 'checkout with spaces');
  mkdirSync(root);
  writeFileSync(join(root, 'justfile'), source);
  try {
    return action(root);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('readJustCommands', () => {
  it('reads plain, parameterized, dependency recipes and aliases', () => {
    withJustfile(
      'alias b := build\nbuild version="1": lint\n  echo {{version}}\nlint:\n  echo lint\n',
      (root) => {
        expect(readJustCommands(root)).toEqual({
          recipes: new Set(['build', 'lint']),
          aliases: new Map([['b', 'build']]),
        });
      },
    );
  });

  it('includes imported recipes and resolves their aliases', () => {
    withJustfile("import 'recipes.just'\nalias short := imported\n", (root) => {
      writeFileSync(join(root, 'recipes.just'), 'imported:\n  echo imported\n');
      const commands = readJustCommands(root);
      expect(commands.recipes.has('imported')).toBe(true);
      expect(commands.aliases.get('short')).toBe('imported');
      expect(classifyRecipe('short', commands)).toMatchObject({
        allowed: true,
        recipe: 'imported',
      });
      expect(classifyRecipe('missing', commands).allowed).toBe(false);
    });
  });

  it('preserves remote refusal through a justfile alias', () => {
    withJustfile('alias in := ios-native\nios-native:\n  echo ios\n', (root) => {
      expect(classifyRecipe('in', readJustCommands(root))).toMatchObject({
        allowed: false,
        recipe: 'ios-native',
        reason: expect.stringContaining('macOS-only'),
      });
    });
  });

  it('fails when just cannot parse the checkout instead of returning an empty command list', () => {
    withJustfile("import 'missing.just'\n", (root) => {
      expect(() => readJustCommands(root)).toThrow('missing.just');
    });
  });
});

describe('readJustfileSource', () => {
  it('follows the root import lines so text checks see every recipe', () => {
    withJustfile("set positional-arguments\nimport 'just/a.justfile'\n", (root) => {
      mkdirSync(join(root, 'just'));
      writeFileSync(join(root, 'just', 'a.justfile'), 'imported:\n  echo imported\n');
      expect(justfilePaths(root)).toEqual(['justfile', 'just/a.justfile']);
      const source = readJustfileSource(root);
      expect(source).toContain('set positional-arguments');
      expect(source).toMatch(/^imported:$/m);
    });
  });
});
