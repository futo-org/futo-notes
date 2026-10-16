import { describe, expect, it } from 'vitest';

import { SPLIT_TORTURE_CASES } from './splitTortureCases';

describe('split-torture semantic selections', () => {
  it('provides a unique bounded rich-text point for every source-offset selection', () => {
    for (const gauntletCase of SPLIT_TORTURE_CASES) {
      const rich = gauntletCase.selection.rich;
      expect.soft(rich, `${gauntletCase.id} rich selection`).toBeDefined();
      for (const point of [rich?.anchor, rich?.head].filter((value) => value !== undefined)) {
        const occurrences = gauntletCase.initialSource.split(point.text).length - 1;
        expect.soft(occurrences, `${gauntletCase.id} rich point uniqueness`).toBe(1);
        expect.soft(point.offset, `${gauntletCase.id} rich point offset`).toBeGreaterThanOrEqual(0);
        expect
          .soft(point.offset, `${gauntletCase.id} rich point offset`)
          .toBeLessThanOrEqual(point.text.length);
      }
    }
  });
});
