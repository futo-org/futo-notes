// Read command names and alias targets through just's own parser. Both the
// instruction gate and remote runner need the commands in this checkout.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function readJustCommands(root) {
  const metadata = JSON.parse(
    execFileSync(
      'just',
      ['--justfile', path.join(root, 'justfile'), '--dump', '--dump-format', 'json'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ),
  );
  return {
    recipes: new Set(Object.keys(metadata.recipes)),
    aliases: new Map(Object.entries(metadata.aliases).map(([name, alias]) => [name, alias.target])),
  };
}

// The root justfile holds settings and aliases and imports the recipe files
// under just/. Text checks run where `just` is absent (the pinned CI image), so
// they follow the `import` lines themselves. Paths are relative to `root`.
export function justfilePaths(root) {
  const source = readFileSync(path.join(root, 'justfile'), 'utf8');
  const imports = [...source.matchAll(/^import '([^']+)'$/gm)].map((match) => match[1]);
  return ['justfile', ...imports];
}

// Every justfile source as one text, root first, for checks that grep recipes.
export function readJustfileSource(root) {
  return justfilePaths(root)
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
}
