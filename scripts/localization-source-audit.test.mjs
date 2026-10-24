import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-localization audit-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'languages'));
  fs.copyFileSync('languages/catalog.schema.json', path.join(dir, 'languages/catalog.schema.json'));
  fs.writeFileSync(
    path.join(dir, 'languages/en.json'),
    JSON.stringify({
      $schema: './catalog.schema.json',
      language: { englishName: 'English', nativeName: 'English', direction: 'ltr', aliases: [] },
      messages: {
        first: {
          title: 'One',
          count: { plural: 'count', variants: { one: '{count} item', other: '{count} items' } },
        },
        second: { title: 'Two' },
      },
    }),
  );
  const files = {
    'View.svelte': '<button title="Both \'quote\' styles">{localizedText(`first.title`)}</button>',
    'View.swift': 'Text(localizedText("second.title"))\nText("Uncataloged title")',
    'View.kt': 'Text(localizedText(messagePath))\nText("Other title")',
    'state.ts': 'localizedText(`first.${kind}`); const text = "don\'t run $(touch sentry)";',
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
function run(dir, ...args) {
  return spawnSync(
    process.execPath,
    ['scripts/localization-source-audit.mjs', '--root', dir, ...args],
    { encoding: 'utf8', timeout: 10000 },
  );
}
it('inventories catalog leaves and quoted/dynamic source lines without shell quoting or callback-index corruption', () => {
  const dir = fixture();
  const result = run(dir, '.');
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.catalogPaths).toEqual(['first.count', 'first.title', 'second.title']);
  expect(report.calls.map((row) => row.path).sort()).toEqual([
    'View.kt',
    'View.svelte',
    'View.swift',
    'state.ts',
  ]);
  expect(report.calls.find((row) => row.path === 'View.kt').text).toContain('messagePath');
  expect(report.calls.find((row) => row.path === 'state.ts').text).toContain('${kind}');
  expect(report.quotedLines.find((row) => row.path === 'View.svelte').text).toContain("'quote'");
  expect(report.quotedLines.some((row) => row.text.includes('Uncataloged title'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'sentry'))).toBe(false);
});
it('reports no matches as empty data, and rejects missing paths and broken catalogs', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'empty.ts'), 'export const answer = 42;');
  expect(JSON.parse(run(dir, 'empty.ts').stdout).calls).toEqual([]);
  const missing = run(dir, 'missing.swift');
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('missing.swift');
  fs.writeFileSync(path.join(dir, 'languages/en.json'), '{');
  expect(run(dir, '.').status).toBe(1);
});
