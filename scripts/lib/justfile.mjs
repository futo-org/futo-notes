// Read command names and alias targets through just's own parser. Both the
// instruction gate and remote runner need the commands in this checkout.
import { execFileSync } from 'node:child_process';
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
