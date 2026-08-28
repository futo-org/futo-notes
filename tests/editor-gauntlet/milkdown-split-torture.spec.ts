import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { detectTextLoss } from './lossOracle';
import { MilkdownGauntletAdapter } from './milkdownAdapter';
import { checkSemanticIntent } from './semanticIntent';
import {
  compareToBaseline,
  readScoreBaseline,
  writeScoreBaseline,
  type CaseOutcome,
} from './scoreBaseline';
import { SPLIT_TORTURE_CASES } from './splitTortureCases';

const BASELINE_PATH = path.resolve('tests/editor-gauntlet/milkdown-split-torture.baseline.json');
const REPORT_PATH = path.resolve('tests/editor-gauntlet/local/milkdown-split-torture.json');

/**
 * The 56-case split-torture matrix against Milkdown, scored.
 *
 * One test rather than 56: the adapter holds a single page for the whole run
 * (a fresh browser context per case would spend most of the suite booting the
 * bundle), and the ledger comparison needs every outcome anyway. Each case is a
 * `test.step`, so the report still names them individually.
 */
test('milkdown split-torture score matches the recorded ledger', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const adapter = new MilkdownGauntletAdapter(browser);
  const outcomes: CaseOutcome[] = [];

  try {
    for (const gauntletCase of SPLIT_TORTURE_CASES) {
      await test.step(gauntletCase.id, async () => {
        const failures: string[] = [];
        // Reported, never gated: how often the round trip is byte-for-byte
        // identical is the normalize-once scorecard (plan D4), not a bar.
        let undoByteExact = false;
        let savedSource: string | undefined;
        try {
          await adapter.open(gauntletCase.initialSource, gauntletCase.id);
          await adapter.select(gauntletCase.selection);
          const renders = await adapter.perform(gauntletCase.action);
          const saved = await adapter.save();
          savedSource = saved.source;

          if (saved.refused) failures.push('the edit refused instead of saving');
          if (saved.warnings.length > 0) {
            failures.push(`preservation warning: ${saved.warnings.join(' | ')}`);
          }
          if (saved.shellSource !== saved.source) {
            failures.push('the shell save payload does not match the editor source');
          }
          if (saved.savedSource !== saved.source) {
            failures.push('the persisted note does not match the editor source');
          }

          const intent = checkSemanticIntent(saved, gauntletCase.intent);
          if (!intent.ok) {
            failures.push(
              `saved markdown lost the semantic intent: ${JSON.stringify({
                missingStyledText: intent.missingStyledText,
                missingVisibleText: intent.missingVisibleText,
                structureErrors: intent.structureErrors,
              })}`,
            );
          }
          renders.forEach((snapshot, index) => {
            if (!checkSemanticIntent(snapshot, gauntletCase.intent).ok) {
              failures.push(`observed render ${index} lost the semantic intent`);
            }
          });

          // Undo is held to the loss-only bar, not byte fidelity: ADR-0002
          // accepts that a round trip through a WYSIWYG editor rewrites
          // markdown syntax, so restoring `before **a** x` as
          // `before **a** x\n` is the editor working, not undo failing. What
          // undo must do is bring back every word and leave the shell and the
          // file agreeing with the editor.
          const undone = await adapter.undo();
          undoByteExact = undone.source === gauntletCase.initialSource;
          if (undone.refused) failures.push('undo refused instead of saving');
          const undoLoss = detectTextLoss(gauntletCase.initialSource, undone.source);
          if (undoLoss.lostTokens.length > 0) {
            failures.push(`undo lost text: ${undoLoss.lostTokens.join(', ')}`);
          }
          if (undone.savedSource !== undone.source) {
            failures.push('after undo the persisted note does not match the editor source');
          }
          if (undone.shellSource !== undone.source) {
            failures.push('after undo the shell payload does not match the editor source');
          }
        } catch (error) {
          failures.push(`adapter error: ${(error as Error).message}`);
        }
        outcomes.push({
          id: gauntletCase.id,
          ok: failures.length === 0,
          failures,
          undoByteExact,
          savedSource,
        });
      });
    }
  } finally {
    await adapter.dispose();
  }

  const passed = outcomes.filter((outcome) => outcome.ok).length;
  const undoByteExact = outcomes.filter((outcome) => outcome.undoByteExact).length;
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(
    REPORT_PATH,
    `${JSON.stringify(
      { candidate: adapter.name, total: outcomes.length, passed, undoByteExact, outcomes },
      null,
      2,
    )}\n`,
  );
  console.log(
    `EDITOR_GAUNTLET_SPLIT_TORTURE ${JSON.stringify({
      candidate: adapter.name,
      passed,
      total: outcomes.length,
      undoByteExact,
    })}`,
  );

  if (process.env.EDITOR_GAUNTLET_UPDATE_BASELINE === '1') {
    writeScoreBaseline(BASELINE_PATH, outcomes);
    throw new Error(
      'baseline rewritten from this run — review the diff and re-run without ' +
        'EDITOR_GAUNTLET_UPDATE_BASELINE',
    );
  }

  expect(outcomes, 'every matrix case must produce an outcome').toHaveLength(
    SPLIT_TORTURE_CASES.length,
  );
  const drift = compareToBaseline(readScoreBaseline(BASELINE_PATH), outcomes);
  expect
    .soft(drift.regressions, 'these cases passed at the recorded score and now fail')
    .toEqual([]);
  expect(
    drift.staleEntries,
    'these cases now pass — delete their milkdown-split-torture.baseline.json entries',
  ).toEqual([]);
});
