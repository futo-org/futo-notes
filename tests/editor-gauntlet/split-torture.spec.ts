import { expect, test } from '@playwright/test';

import { Cm6GauntletAdapter } from './cm6Adapter';
import { checkSemanticIntent } from './semanticIntent';
import { SPLIT_TORTURE_CASES } from './splitTortureCases';

test.describe('editor gauntlet: split-torture baseline', () => {
  for (const gauntletCase of SPLIT_TORTURE_CASES) {
    test(gauntletCase.id, async ({ page }) => {
      const adapter = new Cm6GauntletAdapter(page);
      await adapter.open(gauntletCase.initialSource, gauntletCase.id);
      await adapter.select(gauntletCase.selection);

      const renderObservations = await adapter.perform(gauntletCase.action);
      const saved = await adapter.save();
      const intentResult = checkSemanticIntent(saved, gauntletCase.intent);
      const brokenRenderObservations = renderObservations
        .map((snapshot, index) => ({
          index,
          result: checkSemanticIntent(snapshot, gauntletCase.intent),
        }))
        .filter(({ result }) => !result.ok);

      expect.soft(saved.refused, 'the edit must save instead of refusing').toBe(false);
      expect.soft(saved.warnings, 'the edit must not surface a preservation warning').toEqual([]);
      expect
        .soft(saved.shellSource, 'the shell save payload must match the editor source')
        .toBe(saved.source);
      expect
        .soft(saved.savedSource, 'the persisted note must match the editor source')
        .toBe(saved.source);
      expect
        .soft(intentResult, 'saved markdown must preserve the requested semantic intent')
        .toMatchObject({
          ok: true,
          missingStyledText: [],
          missingVisibleText: [],
          structureErrors: [],
        });
      expect
        .soft(
          brokenRenderObservations,
          'no observed post-edit render may lose the requested semantic meaning',
        )
        .toEqual([]);

      const undone = await adapter.undo();
      expect.soft(undone.refused, 'undo must save instead of refusing').toBe(false);
      expect
        .soft(undone.savedSource, 'undo must restore the prior persisted bytes')
        .toBe(gauntletCase.initialSource);
      expect
        .soft(undone.shellSource, 'undo must restore the prior shell payload bytes')
        .toBe(gauntletCase.initialSource);
      expect(undone.source, 'undo must restore the prior editor bytes exactly').toBe(
        gauntletCase.initialSource,
      );
    });
  }
});
