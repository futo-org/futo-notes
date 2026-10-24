#!/usr/bin/env node
// Read-only localization review inventory. Uses ripgrep JSON, passed as argv,
// so quote/backtick patterns never pass through shell evaluation. This is a
// line inventory for human review, not a parser or a localization-compliance gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateLanguageCatalogs } from './language-catalogs.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPaths = ['src', 'packages/editor', 'apps/ios', 'apps/android'];
const quoted = '["\x27`]';

function matchingLines(root, paths, pattern) {
  const result = spawnSync(
    'rg',
    [
      '--json',
      '--line-number',
      '--glob',
      '*.ts',
      '--glob',
      '*.svelte',
      '--glob',
      '*.swift',
      '--glob',
      '*.kt',
      '--regexp',
      pattern,
      '--',
      ...paths,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`Localization source scan failed: ${result.stderr.trim() || result.status}`);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const event = JSON.parse(line);
      if (event.type !== 'match') return [];
      return [
        {
          path: path
            .relative(root, path.resolve(root, event.data.path.text))
            .split(path.sep)
            .join('/'),
          line: event.data.line_number,
          text: event.data.lines.text.replace(/\r?\n$/, ''),
        },
      ];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}

export function auditLocalizationSource({ root = repositoryRoot, paths = defaultPaths } = {}) {
  root = path.resolve(root);
  const validation = validateLanguageCatalogs({
    languagesDirectory: path.join(root, 'languages'),
    schemaPath: path.join(root, 'languages/catalog.schema.json'),
  });
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  const english = validation.catalogs.get('en');
  if (!english) throw new Error('English source catalog en.json is required');
  for (const sourcePath of paths) fs.statSync(path.resolve(root, sourcePath));
  return {
    catalogPaths: [...english.messages.keys()].sort(),
    calls: matchingLines(root, paths, '\\blocalizedText\\s*\\('),
    quotedLines: matchingLines(root, paths, quoted),
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      console.log('Usage: just audit-localization-source [--root directory] [source paths ...]');
      console.log(
        'Prints JSON catalog paths, localizedText call lines and lines with quotes/backticks. Review candidates manually.',
      );
    } else {
      let root = repositoryRoot;
      const sources = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--root') {
          if (!args[i + 1] || args[i + 1].startsWith('-'))
            throw new Error('--root needs a directory');
          root = args[++i];
        } else if (args[i].startsWith('-')) throw new Error(`Unknown argument: ${args[i]}`);
        else sources.push(args[i]);
      }
      console.log(
        JSON.stringify(
          auditLocalizationSource({ root, paths: sources.length ? sources : defaultPaths }),
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
