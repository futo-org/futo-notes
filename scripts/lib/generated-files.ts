import fs from 'node:fs';
import path from 'node:path';

export type GeneratedTarget = { rel: string; render: () => string };

export function updateGeneratedFiles(
  root: string,
  targets: GeneratedTarget[],
  source: string,
  recipe: string,
  check = process.argv.includes('--check'),
): void {
  let stale = false;

  for (const target of targets) {
    const abs = path.join(root, target.rel);
    const next = target.render();
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (current === next) {
      console.log(`${target.rel}: up to date`);
    } else if (check) {
      console.error(`${target.rel} is STALE vs ${source} — run \`just ${recipe}\` and commit.`);
      stale = true;
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, next);
      console.log(`${target.rel}: written`);
    }
  }

  if (stale) process.exitCode = 1;
}
