import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { Cm6GauntletAdapter } from './cm6Adapter';
import {
  CM6_FLOOR_FIXTURES,
  PERFORMANCE_BUDGET,
  evaluatePerformanceFloor,
  runPerformanceFloor,
} from './performanceFloor';

test('current CM6 meets the editor performance floor', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const adapter = new Cm6GauntletAdapter(page);
  // CM6 keeps a hard open budget at EVERY size. The plan's linear-above-real-
  // note-sizes policy exists for the candidate replacing it; CM6 has met the
  // flat bar since the bakeoff, and relaxing it here would only lose coverage.
  const results = await runPerformanceFloor(adapter, CM6_FLOOR_FIXTURES);
  const violations = evaluatePerformanceFloor(CM6_FLOOR_FIXTURES, results);
  const report = { candidate: adapter.name, budget: PERFORMANCE_BUDGET, results, violations };
  const reportDir = path.resolve('tests/editor-gauntlet/local');
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, 'current-cm6-performance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`EDITOR_GAUNTLET_PERF ${JSON.stringify(report)}`);

  expect(
    results.map((result) => result.fixture),
    'every fixture must produce a measurement',
  ).toEqual(CM6_FLOOR_FIXTURES.map((fixture) => fixture.name));
  expect(violations, 'the performance floor must hold').toEqual([]);
});
