// Shared reads for the pre-merge CI routing contract tests
// (premerge-test-parity*.test.mjs): the operational files they assert on, and
// the one parser they share.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { justfilePaths, readJustfileSource } from './lib/justfile.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const justfile = readJustfileSource(ROOT);
// The same text per file, for checks that report a file and line number.
export const justfileSources = Object.fromEntries(
  justfilePaths(ROOT).map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]),
);
export const gitlabPipeline = readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf8');
export const packageScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
export const cirrusTasks = readFileSync(join(ROOT, '.cirrus.yml'), 'utf8');
export const androidInstrumentationScript = readFileSync(
  join(ROOT, 'scripts/ci-android-instrumentation.sh'),
  'utf8',
);
export const androidEmulatorScript = readFileSync(
  join(ROOT, 'scripts/ci-android-emulator.sh'),
  'utf8',
);
export const androidSyncLegScript = readFileSync(
  join(ROOT, 'scripts/ci-android-sync-leg.sh'),
  'utf8',
);
export const androidRunScript = readFileSync(join(ROOT, 'apps/android/run.sh'), 'utf8');
export const fdroidIndexScript = readFileSync(join(ROOT, 'scripts/update-fdroid-index.py'), 'utf8');
export const iosStoryAvailabilityGate = readFileSync(
  join(ROOT, 'scripts/run-ios-stories-if-available.sh'),
  'utf8',
);

export function topLevelBlock(contents, startPattern) {
  const match = startPattern.exec(contents);
  if (match?.index == null) throw new Error(`Missing operational entry point: ${startPattern}`);

  const blockStart = match.index;
  const remainingContents = contents.slice(blockStart + match[0].length);
  const nextBlockOffset = remainingContents.search(/^\S[^\n]*:\s*(?:#.*)?$/m);

  return nextBlockOffset === -1
    ? contents.slice(blockStart)
    : contents.slice(blockStart, blockStart + match[0].length + nextBlockOffset);
}
