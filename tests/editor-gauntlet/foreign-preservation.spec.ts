import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { Cm6GauntletAdapter } from './cm6Adapter';
import { loadForeignNotes } from './foreignCorpus';
import { runForeignPreservationSweep } from './foreignPreservation';

const corpusPath = process.env.EDITOR_GAUNTLET_CORPUS;
const noteLimit = Number.parseInt(process.env.EDITOR_GAUNTLET_CORPUS_LIMIT ?? '100', 10);

test('current CM6 preserves foreign files', async ({ page }) => {
  test.skip(!corpusPath, 'set EDITOR_GAUNTLET_CORPUS after reading the corpus NOTICE');
  test.setTimeout(30 * 60_000);

  const notes = await loadForeignNotes(corpusPath!, noteLimit);
  expect(notes.length, 'the configured corpus must yield at least one note').toBeGreaterThan(0);
  const adapter = new Cm6GauntletAdapter(page);
  const result = await runForeignPreservationSweep(adapter, notes);
  const report = {
    candidate: adapter.name,
    corpus: path.basename(corpusPath!),
    requestedNoteLimit: noteLimit,
    ...result,
  };
  const reportDir = path.resolve('tests/editor-gauntlet/local');
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, 'current-cm6-foreign-preservation.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`EDITOR_GAUNTLET_FOREIGN ${JSON.stringify(report)}`);

  expect.soft(result.refusals, 'tier 1 requires zero refused edits').toBe(0);
  expect.soft(result.warnings, 'tier 2 requires zero preservation warnings').toBe(0);
  expect.soft(result.exactOnlyNotes, 'rich editing must remain available').toBe(0);
  expect(result.outsideBlockRewrites, 'no edit may rewrite outside its parsed block').toBe(0);
});
